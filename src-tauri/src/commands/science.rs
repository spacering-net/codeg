//! Built-in scientific-research skills management.
//!
//! This is a third bundled skill source that mirrors `commands/experts.rs`
//! almost verbatim. Science skills (curated from
//! K-Dense-AI/scientific-agent-skills) are bundled into the binary via
//! `include_dir!` and, on startup, extracted into the same central store as
//! experts — `~/.codeg/skills/<id>/`. Users enable a science skill for any ACP
//! agent by symlinking (or Windows-junctioning) the agent's skill dir into the
//! central copy.
//!
//! Why a near-copy instead of a shared abstraction: experts/office already run
//! two writers into the central store safely by relying on **disjoint id
//! namespaces** plus a simple hash+manifest+backup scheme — not a bespoke
//! multi-writer protocol. Science is a third writer with ids that are disjoint
//! from experts (`brainstorming`, …) and office (`officecli-*`) by curation, so
//! it inherits the same safety posture. The only structural differences from
//! `experts.rs` are: its own `SCIENCE_BUNDLE`, its own `.manifest.science.json`
//! (so it never clobbers experts' `.manifest.json`), its own `supported_agents`,
//! and four extra `science.toml` fields (featured/accent/needs_key/needs_env).
//! The generic link primitives and link-state DTOs are reused from experts —
//! exactly as `office_tools.rs` does — so science link statuses serialize
//! identically and the frontend enablement merge stays uniform.
//!
//! Factoring the shared hash/extract/install glue into one helper is a
//! deliberate future refactor (see docs/science-mode-spec.md §9), not a v1 goal.

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
// Reuse the generic filesystem link primitives and link-state DTOs from experts
// (same boundary office_tools.rs uses). The central store is shared, so science
// installs into `central_experts_dir()` too.
use crate::commands::experts::{
    central_experts_dir, classify_link, create_link_raw, path_is_symlink, read_link_target,
    ExpertInstallStatus, ExpertLinkState, LinkOp, LinkOpResult,
};
use crate::models::agent::AgentType;

// ─── Embedded bundle ────────────────────────────────────────────────────

static SCIENCE_BUNDLE: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/science");

const MANIFEST_FILE: &str = ".manifest.science.json";
const SCIENCE_TOML: &str = "science.toml";

// ─── Error type ─────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum ScienceError {
    #[error("science skill not found: {0}")]
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
    #[error("central science store is unavailable: {0}")]
    CentralUnavailable(String),
}

impl Serialize for ScienceError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<io::Error> for ScienceError {
    fn from(err: io::Error) -> Self {
        ScienceError::Io(err.to_string())
    }
}

// ─── Public types ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct ScienceMetadata {
    pub id: String,
    pub category: String,
    pub icon: Option<String>,
    pub sort_order: i32,
    /// Surface as a card in the new-session "Scientific Research" tab.
    pub featured: bool,
    /// Color key indexing the literal ACCENTS map in quick-actions.tsx
    /// (featured cards only).
    pub accent: Option<String>,
    /// The skill's primary workflow requires an external API key.
    pub needs_key: bool,
    /// The skill ships scripts that may need a Python/uv environment.
    pub needs_env: bool,
    pub display_name: BTreeMap<String, String>,
    pub description: BTreeMap<String, String>,
    pub bundled_hash: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScienceListItem {
    pub metadata: ScienceMetadata,
    pub installed_centrally: bool,
    pub user_modified: bool,
    pub central_path: String,
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
    science: BTreeMap<String, ManifestEntry>,
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
// The central store is shared with experts (`~/.codeg/skills/`); only the
// manifest file differs, so the two sources never clobber each other's state.

fn manifest_path() -> PathBuf {
    central_experts_dir().join(MANIFEST_FILE)
}

fn science_central_path(skill_id: &str) -> PathBuf {
    central_experts_dir().join(skill_id)
}

fn agent_link_path(agent: AgentType, skill_id: &str) -> Result<PathBuf, ScienceError> {
    let dir = preferred_scope_skill_dir(agent, AgentSkillScope::Global, None)
        .map_err(|_| ScienceError::UnsupportedAgent(agent))?;
    Ok(dir.join(skill_id))
}

// ─── Metadata loading ───────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct ScienceTomlRoot {
    #[serde(default)]
    skill: Vec<ScienceTomlEntry>,
}

#[derive(Debug, Deserialize)]
struct ScienceTomlEntry {
    id: String,
    category: String,
    #[serde(default)]
    icon: Option<String>,
    #[serde(default)]
    sort_order: i32,
    #[serde(default)]
    featured: bool,
    #[serde(default)]
    accent: Option<String>,
    #[serde(default)]
    needs_key: bool,
    #[serde(default)]
    needs_env: bool,
    #[serde(default)]
    display_name: BTreeMap<String, String>,
    #[serde(default)]
    description: BTreeMap<String, String>,
}

fn bundled_metadata() -> &'static [ScienceMetadata] {
    static METADATA: OnceLock<Vec<ScienceMetadata>> = OnceLock::new();
    METADATA.get_or_init(|| match load_bundled_metadata_inner() {
        Ok(list) => list,
        Err(err) => {
            tracing::error!("[Science] failed to load bundled metadata: {err}");
            Vec::new()
        }
    })
}

fn load_bundled_metadata_inner() -> Result<Vec<ScienceMetadata>, ScienceError> {
    let toml_file = SCIENCE_BUNDLE
        .get_file(SCIENCE_TOML)
        .ok_or_else(|| ScienceError::Metadata(format!("{SCIENCE_TOML} missing from bundle")))?;
    let toml_str = toml_file
        .contents_utf8()
        .ok_or_else(|| ScienceError::Metadata(format!("{SCIENCE_TOML} is not valid UTF-8")))?;
    let root: ScienceTomlRoot = toml::from_str(toml_str)
        .map_err(|e| ScienceError::Metadata(format!("failed to parse {SCIENCE_TOML}: {e}")))?;

    let mut out = Vec::with_capacity(root.skill.len());
    for entry in root.skill {
        let bundled_hash = hash_bundled_science(&entry.id)?;
        out.push(ScienceMetadata {
            id: entry.id,
            category: entry.category,
            icon: entry.icon,
            sort_order: entry.sort_order,
            featured: entry.featured,
            accent: entry.accent,
            needs_key: entry.needs_key,
            needs_env: entry.needs_env,
            display_name: entry.display_name,
            description: entry.description,
            bundled_hash,
        });
    }
    out.sort_by(|a, b| a.sort_order.cmp(&b.sort_order).then_with(|| a.id.cmp(&b.id)));
    Ok(out)
}

/// Ids of all bundled science skills. Used by the custom-skills pack to exclude
/// built-in ids from the "custom" set (all packs share the central store).
pub(crate) fn bundled_ids() -> Vec<String> {
    bundled_metadata().iter().map(|m| m.id.clone()).collect()
}

fn find_metadata(skill_id: &str) -> Result<&'static ScienceMetadata, ScienceError> {
    bundled_metadata()
        .iter()
        .find(|m| m.id == skill_id)
        .ok_or_else(|| ScienceError::NotFound(skill_id.to_string()))
}

// ─── Hashing ────────────────────────────────────────────────────────────
// Copied from experts.rs (generic bundle/disk hashing). The logical path
// format — `skills/<id>/<rel>` — is identical, so hashes are comparable within
// this module's own manifest.

fn hash_bundled_science(skill_id: &str) -> Result<String, ScienceError> {
    let skill_dir = format!("skills/{skill_id}");
    let dir = SCIENCE_BUNDLE
        .get_dir(&skill_dir)
        .ok_or_else(|| ScienceError::NotFound(skill_id.to_string()))?;
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

fn hash_disk_directory(path: &Path) -> Result<String, ScienceError> {
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    collect_disk_files(path, path, &mut files)?;
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let mut hasher = Sha256::new();
    for (rel_path, contents) in files {
        let logical = format!(
            "skills/{}/{}",
            path.file_name().and_then(|s| s.to_str()).unwrap_or_default(),
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
) -> Result<(), ScienceError> {
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
                .map_err(|e| ScienceError::Io(e.to_string()))?
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

fn save_manifest(manifest: &Manifest) -> Result<(), ScienceError> {
    let path = manifest_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let serialized = serde_json::to_string_pretty(manifest)
        .map_err(|e| ScienceError::Metadata(format!("failed to serialize manifest: {e}")))?;
    fs::write(&path, serialized)?;
    Ok(())
}

// ─── Central store installation ────────────────────────────────────────

pub async fn ensure_central_science_installed() -> InstallReport {
    let _guard = mutation_lock().lock().await;
    tokio::task::spawn_blocking(ensure_central_science_installed_blocking)
        .await
        .unwrap_or_else(|e| {
            let mut r = InstallReport::default();
            r.errors.push(format!("join error: {e}"));
            r
        })
}

fn ensure_central_science_installed_blocking() -> InstallReport {
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
        match install_or_refresh_science(meta, &mut manifest) {
            Ok(InstallAction::Skipped) => {}
            Ok(InstallAction::Installed) => report.installed_count += 1,
            Ok(InstallAction::Updated) => report.updated_count += 1,
            Ok(InstallAction::BackedUp) => {
                report.updated_count += 1;
                report.pending_user_review.push(meta.id.clone());
            }
            Err(e) => report.errors.push(format!("{}: {}", meta.id, e)),
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

fn install_or_refresh_science(
    meta: &ScienceMetadata,
    manifest: &mut Manifest,
) -> Result<InstallAction, ScienceError> {
    let central_path = science_central_path(&meta.id);
    let bundled_hash = &meta.bundled_hash;
    let manifest_entry = manifest.science.get(&meta.id).cloned().unwrap_or_default();

    if central_path.exists() {
        let on_disk_hash = hash_disk_directory(&central_path).unwrap_or_default();
        if &on_disk_hash == bundled_hash {
            // Up-to-date and pristine. Ensure manifest matches.
            if manifest_entry.hash != *bundled_hash {
                manifest.science.insert(
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

        // Content differs. Was the user the one who changed it, or is the
        // bundle itself newer?
        let user_modified = manifest_entry.hash.is_empty() || on_disk_hash != manifest_entry.hash;
        if user_modified {
            // Preserve user work (or a foreign same-named dir): move aside,
            // install fresh. Non-destructive, matching experts' behavior.
            let backup_name = format!(
                "{}.user-backup-{}",
                meta.id,
                Utc::now().format("%Y%m%d-%H%M%S")
            );
            let backup_path = central_experts_dir().join(backup_name);
            fs::rename(&central_path, &backup_path)?;
            extract_science_to_disk(meta, &central_path)?;
            manifest.science.insert(
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
            .map_err(|e| ScienceError::Io(format!("remove stale science skill: {e}")))?;
        extract_science_to_disk(meta, &central_path)?;
        manifest.science.insert(
            meta.id.clone(),
            ManifestEntry {
                hash: bundled_hash.clone(),
                installed_at: Utc::now().to_rfc3339(),
                pending_user_review: false,
            },
        );
        Ok(InstallAction::Updated)
    } else {
        extract_science_to_disk(meta, &central_path)?;
        manifest.science.insert(
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

fn extract_science_to_disk(meta: &ScienceMetadata, target: &Path) -> Result<(), ScienceError> {
    let skill_rel = format!("skills/{}", meta.id);
    let dir = SCIENCE_BUNDLE
        .get_dir(&skill_rel)
        .ok_or_else(|| ScienceError::NotFound(meta.id.clone()))?;
    fs::create_dir_all(target)?;
    extract_bundle_dir(dir, &skill_rel, target)?;
    Ok(())
}

fn extract_bundle_dir(
    dir: &Dir<'_>,
    bundle_prefix: &str,
    target: &Path,
) -> Result<(), ScienceError> {
    for entry in dir.entries() {
        match entry {
            DirEntry::File(f) => {
                let rel = f
                    .path()
                    .to_str()
                    .ok_or_else(|| ScienceError::Io("non-utf8 path in bundle".into()))?;
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
                // scripts would extract as non-executable and fail when a skill
                // invokes them by path. Restore the execute bit for any file
                // that declares a shebang.
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
pub async fn science_list() -> Result<Vec<ScienceListItem>, ScienceError> {
    let meta_list = bundled_metadata().to_vec();
    let manifest = load_manifest();
    let mut out = Vec::with_capacity(meta_list.len());
    for meta in meta_list {
        let central_path = science_central_path(&meta.id);
        let installed_centrally = central_path.exists();
        let user_modified = manifest
            .science
            .get(&meta.id)
            .map(|e| e.pending_user_review)
            .unwrap_or(false);
        out.push(ScienceListItem {
            metadata: meta,
            installed_centrally,
            user_modified,
            central_path: central_path.to_string_lossy().to_string(),
        });
    }
    Ok(out)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn science_get_install_status(
    skill_id: String,
) -> Result<Vec<ExpertInstallStatus>, ScienceError> {
    let skill_id =
        validate_skill_id(&skill_id).map_err(|e| ScienceError::Metadata(e.to_string()))?;
    let _ = find_metadata(&skill_id)?; // ensure it exists in the bundle
    let expected = science_central_path(&skill_id);
    let agents = supported_agents();

    let mut out = Vec::with_capacity(agents.len());
    for agent in agents {
        let link_path = match agent_link_path(agent, &skill_id) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let state = classify_link(&link_path, &expected);
        let target_path = read_link_target(&link_path).map(|p| p.to_string_lossy().to_string());
        out.push(ExpertInstallStatus {
            expert_id: skill_id.clone(),
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
    // Every built-in that declares a skill store, same order as `experts.rs` /
    // `office_tools.rs`. This is not a curated subset: the matrix renders one
    // column per `skills_capable` agent (`acp_list_agents`), so a built-in
    // missing here gets a column whose authoritative status never arrives — the
    // cell the user just enabled flips straight back off, and re-enabling walks
    // into the already-created link (#718). The test at the bottom of this file
    // is the gate that keeps the list complete.
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

/// Link one science skill into one agent's skill dir. **Assumes the mutation
/// lock is already held** by the caller — `tokio::sync::Mutex` is not reentrant,
/// so the batch path (`science_apply_links`) locks once and calls this directly
/// rather than the public command (which would self-deadlock).
fn link_one_locked(
    skill_id: &str,
    agent_type: AgentType,
) -> Result<ExpertInstallStatus, ScienceError> {
    let skill_id = validate_skill_id(skill_id).map_err(|e| ScienceError::Metadata(e.to_string()))?;
    let _ = find_metadata(&skill_id)?;
    let central = science_central_path(&skill_id);
    if !central.exists() {
        return Err(ScienceError::CentralUnavailable(format!(
            "science skill '{skill_id}' is not installed in central store"
        )));
    }

    let link_path = agent_link_path(agent_type, &skill_id)?;
    if let Some(parent) = link_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut copy_mode = false;
    match create_link_raw(&central, &link_path) {
        Ok(is_copy) => {
            copy_mode = is_copy;
        }
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
            match classify_link(&link_path, &central) {
                ExpertLinkState::LinkedToCodeg => {
                    // Idempotent success.
                }
                ExpertLinkState::BlockedByRealDirectory => {
                    return Err(ScienceError::NameCollision {
                        path: link_path.to_string_lossy().to_string(),
                    });
                }
                ExpertLinkState::LinkedElsewhere | ExpertLinkState::Broken => {
                    let found = read_link_target(&link_path)
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_else(|| "<unknown>".into());
                    return Err(ScienceError::ForeignLink {
                        path: link_path.to_string_lossy().to_string(),
                        found,
                    });
                }
                ExpertLinkState::NotLinked => {
                    // Shouldn't happen after AlreadyExists, but retry once.
                    create_link_raw(&central, &link_path)
                        .map_err(|e| ScienceError::Io(format!("retry link failed: {e}")))?;
                }
            }
        }
        Err(err) => return Err(ScienceError::Io(err.to_string())),
    }

    let state = classify_link(&link_path, &central);
    let target_path = read_link_target(&link_path).map(|p| p.to_string_lossy().to_string());
    Ok(ExpertInstallStatus {
        expert_id: skill_id.clone(),
        agent_type,
        state,
        link_path: link_path.to_string_lossy().to_string(),
        target_path,
        expected_target_path: central.to_string_lossy().to_string(),
        copy_mode,
    })
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn science_link_to_agent(
    skill_id: String,
    agent_type: AgentType,
) -> Result<ExpertInstallStatus, ScienceError> {
    let _guard = mutation_lock().lock().await;
    link_one_locked(&skill_id, agent_type)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn science_unlink_from_agent(
    skill_id: String,
    agent_type: AgentType,
) -> Result<(), ScienceError> {
    let _guard = mutation_lock().lock().await;
    unlink_one_locked(&skill_id, agent_type)
}

/// Remove one science skill's link from one agent's skill dirs. **Assumes the
/// mutation lock is already held** (see `link_one_locked`).
fn unlink_one_locked(skill_id: &str, agent_type: AgentType) -> Result<(), ScienceError> {
    let skill_id = validate_skill_id(skill_id).map_err(|e| ScienceError::Metadata(e.to_string()))?;

    // Scan ALL global dirs for this agent to handle shared-dir agents — most
    // built-ins also point at the cross-agent `~/.agents/skills/` store, so the
    // link may sit in either. `skill_storage_spec` is the live list; do not
    // enumerate them here, it drifts.
    let dirs = scoped_skill_dirs(agent_type, AgentSkillScope::Global, None)
        .map_err(|_| ScienceError::UnsupportedAgent(agent_type))?;

    let central = science_central_path(&skill_id);
    let mut removed = false;
    for dir in dirs {
        let candidate = dir.join(&skill_id);
        if !candidate.exists() && !path_is_symlink(&candidate) {
            continue;
        }
        let state = classify_link(&candidate, &central);
        if matches!(
            state,
            ExpertLinkState::LinkedToCodeg | ExpertLinkState::Broken
        ) {
            remove_skill_entry(&candidate).map_err(|e| {
                ScienceError::Io(format!("remove link {}: {e}", candidate.display()))
            })?;
            removed = true;
        } else if state == ExpertLinkState::LinkedElsewhere {
            return Err(ScienceError::ForeignLink {
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

    let _ = removed; // already-unlinked is an idempotent success
    Ok(())
}

/// Apply a batch of enable/disable operations under a single lock acquisition.
/// Each op is applied independently: a failing op records `ok: false` and the
/// batch continues. The frontend re-fetches the authoritative snapshot via
/// `science_list_all_install_statuses` afterward (shared agent dirs make per-op
/// state non-local — see the office/experts shared-dir note).
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn science_apply_links(ops: Vec<LinkOp>) -> Result<Vec<LinkOpResult>, ScienceError> {
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

/// One-shot snapshot of every (science skill, agent) link state — lets the
/// matrix UI render the whole grid from a single round-trip.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn science_list_all_install_statuses() -> Result<Vec<ExpertInstallStatus>, ScienceError> {
    let agents = supported_agents();
    let mut out = Vec::with_capacity(bundled_metadata().len() * agents.len());
    for meta in bundled_metadata() {
        let expected = science_central_path(&meta.id);
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
pub async fn science_read_content(skill_id: String) -> Result<String, ScienceError> {
    let skill_id =
        validate_skill_id(&skill_id).map_err(|e| ScienceError::Metadata(e.to_string()))?;
    let _ = find_metadata(&skill_id)?;
    let path = science_central_path(&skill_id).join("SKILL.md");
    if !path.exists() {
        // Fall back to bundled copy when central store isn't populated.
        let bundled_rel = format!("skills/{skill_id}/SKILL.md");
        if let Some(f) = SCIENCE_BUNDLE.get_file(&bundled_rel) {
            if let Some(text) = f.contents_utf8() {
                return Ok(text.to_string());
            }
        }
        return Err(ScienceError::CentralUnavailable(format!(
            "science skill '{skill_id}' has no SKILL.md on disk"
        )));
    }
    let content = fs::read_to_string(&path)?;
    Ok(content)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn science_open_central_dir() -> Result<String, ScienceError> {
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
            registry_id: "science-pack-agent".into(),
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
        let agent = crate::models::agent::AgentType::custom("science-pack-agent").unwrap();

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

    // These tests use ids that are well-formed but absent from the bundle and
    // unlikely to exist as real links, so they never mutate the developer's
    // real skill directories.

    #[tokio::test]
    async fn apply_links_does_not_deadlock() {
        let ops = vec![
            LinkOp {
                expert_id: "zzz-codeg-science-batch-absent-aaa".into(),
                agent_type: AgentType::ClaudeCode,
                enable: false,
            },
            LinkOp {
                expert_id: "zzz-codeg-science-batch-absent-bbb".into(),
                agent_type: AgentType::Codex,
                enable: false,
            },
        ];
        let results = timeout(Duration::from_secs(5), science_apply_links(ops))
            .await
            .expect("science_apply_links must not deadlock")
            .expect("batch returns Ok");
        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|r| r.ok), "{results:?}");
    }

    #[tokio::test]
    async fn apply_links_collects_per_op_results_without_aborting() {
        let ops = vec![
            LinkOp {
                expert_id: "zzz-codeg-science-batch-absent".into(),
                agent_type: AgentType::ClaudeCode,
                enable: false,
            },
            LinkOp {
                // Unknown skill → enable fails at find_metadata, before any fs write.
                expert_id: "zzz-unknown-science-skill".into(),
                agent_type: AgentType::ClaudeCode,
                enable: true,
            },
        ];
        let results = science_apply_links(ops).await.expect("batch returns Ok");
        assert_eq!(results.len(), 2);
        assert!(results[0].ok, "idempotent disable should succeed");
        assert!(!results[1].ok, "unknown skill enable should fail its op");
        assert!(results[1].error.is_some());
        assert!(results[1].status.is_none());
    }

    #[tokio::test]
    // The hydrate guard is held across the await on purpose — see the
    // identical note in `custom_agent_service`.
    #[allow(clippy::await_holding_lock)]
    async fn list_all_install_statuses_covers_every_skill_agent_pair() {
        // A test hydrating a custom agent that declares a store would add a
        // column between the snapshot and the count below.
        let _guard = crate::acp::custom_registry::hydrate_test_guard();
        let rows = science_list_all_install_statuses()
            .await
            .expect("snapshot returns Ok");
        let expected = bundled_metadata().len() * supported_agents().len();
        assert_eq!(rows.len(), expected);
    }

    /// #718: the matrix renders a column per `skills_capable` agent, but the
    /// backend snapshot came from a hand-maintained subset. Antigravity had a
    /// column and no row, so the authoritative refresh that follows a toggle
    /// read the freshly linked cell back as unlinked and flipped it off — and
    /// the re-enable then collided with the link the first one had created.
    /// Both status endpoints must therefore cover every built-in that declares
    /// a skill store.
    ///
    /// Built-ins only: `all_acp_agents()` also reads the process-global custom
    /// registry, which `a_declared_custom_agent_gains_a_column_here_too`
    /// rewrites from another test thread.
    #[tokio::test]
    async fn supported_agents_cover_every_skills_capable_builtin() {
        let expected: Vec<AgentType> = crate::acp::registry::builtin_acp_agents()
            .into_iter()
            .filter(|a| skill_storage_spec(*a).is_some())
            .collect();
        assert!(
            expected.contains(&AgentType::Antigravity),
            "Antigravity declares a skill store, so it is one of the columns"
        );

        let skill_id = bundled_metadata()
            .first()
            .expect("science bundle should be non-empty")
            .id
            .clone();
        let one_skill: Vec<AgentType> = science_get_install_status(skill_id)
            .await
            .expect("status lookup returns Ok")
            .into_iter()
            .map(|row| row.agent_type)
            .collect();
        let whole_grid: Vec<AgentType> = science_list_all_install_statuses()
            .await
            .expect("snapshot returns Ok")
            .into_iter()
            .map(|row| row.agent_type)
            .collect();

        for agent in expected {
            assert!(
                one_skill.contains(&agent),
                "science_get_install_status drops {agent:?}"
            );
            assert!(
                whole_grid.contains(&agent),
                "science_list_all_install_statuses drops {agent:?}"
            );
        }
    }

    #[test]
    fn bundled_metadata_is_disjoint_from_experts() {
        // The safety mechanism: science ids must never collide with experts ids
        // (they share the central store). Curation guarantees this; assert it.
        let science_ids: std::collections::HashSet<_> =
            bundled_metadata().iter().map(|m| m.id.as_str()).collect();
        assert!(!science_ids.is_empty(), "science bundle should be non-empty");
        // A representative experts id must not appear among science ids.
        assert!(!science_ids.contains("brainstorming"));
        assert!(!science_ids.contains("writing-plans"));
    }

    #[test]
    fn every_featured_skill_has_an_accent() {
        for m in bundled_metadata() {
            if m.featured {
                assert!(
                    m.accent.as_deref().map(|a| !a.is_empty()).unwrap_or(false),
                    "featured skill {} must declare an accent",
                    m.id
                );
            }
        }
    }
}
