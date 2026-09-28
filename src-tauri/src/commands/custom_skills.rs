//! Custom (user-authored) skills management.
//!
//! The fourth "skill pack" in codeg's central store `~/.codeg/skills/<id>/`.
//! Unlike experts/science/office — which bundle *read-only* content into the
//! binary — custom skills are created, edited, imported and deleted by the
//! user. They live in the SAME central store and are enabled for an ACP agent
//! the SAME way (a symlink, or Windows junction, from the agent's skill dir
//! into the central copy), so they reuse the experts link engine + DTOs and the
//! matrix UI renders them identically.
//!
//! **Identity by exclusion.** A "custom skill" is any directory in the central
//! store that holds a `SKILL.md` and whose id is NOT claimed by a bundled pack
//! (experts ∪ science ∪ office). This keeps the store's disjoint-id-namespace
//! safety model (see `science.rs`) holding for custom too, and lets a user drop
//! a folder into `~/.codeg/skills` and have it appear on refresh. The startup
//! extraction of bundled packs is id-scoped (hash + manifest + backup, never a
//! wipe), so it never touches unclaimed custom directories.
//!
//! The link primitives, link-state DTOs and central-dir path are reused from
//! `experts.rs` (exactly as `science.rs`/`office_tools.rs` do) so link statuses
//! serialize identically and the frontend enablement merge stays uniform.

use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Serialize;
use tokio::sync::Mutex;

use crate::acp::registry::all_acp_agents;
use crate::acp::types::{AgentSkillLayout, AgentSkillScope};
use crate::commands::acp::{
    locate_existing_skill_across_dirs, preferred_scope_skill_dir, read_skill_description,
    remove_skill_entry, scoped_skill_dirs, skill_storage_spec, validate_skill_id, SkillStorageSpec,
};
// Reuse the generic filesystem link primitives, link-state DTOs and the shared
// central store from experts (the same boundary science/office use).
use crate::commands::experts::{
    central_experts_dir, classify_link, create_link_raw, path_is_symlink, read_link_target,
    ExpertInstallStatus, ExpertLinkState, LinkOp, LinkOpResult,
};
use crate::models::agent::AgentType;

// ─── Error type ─────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum CustomSkillsError {
    #[error("custom skill not found: {0}")]
    NotFound(String),
    #[error("a skill with id '{0}' already exists")]
    AlreadyExists(String),
    #[error("'{0}' is a built-in skill id and can't be used for a custom skill")]
    ReservedId(String),
    #[error("agent does not support skills: {0:?}")]
    UnsupportedAgent(AgentType),
    #[error("a real directory already exists at '{path}' — delete or rename it first")]
    NameCollision { path: String },
    #[error("a different link already exists at '{path}' (points to '{found}') — remove it first")]
    ForeignLink { path: String, found: String },
    #[error("invalid skill source: {0}")]
    InvalidSource(String),
    #[error("io error: {0}")]
    Io(String),
    #[error("metadata error: {0}")]
    Metadata(String),
}

impl Serialize for CustomSkillsError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<io::Error> for CustomSkillsError {
    fn from(err: io::Error) -> Self {
        CustomSkillsError::Io(err.to_string())
    }
}

// ─── Public DTOs ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomSkillItem {
    pub id: String,
    /// Frontmatter `name:` if present, else the id.
    pub name: String,
    /// Best-effort one-line description from the SKILL.md frontmatter.
    pub description: Option<String>,
    pub central_path: String,
}

/// Per-skill outcome for the batch-delete command (a `LinkOpResult` doesn't fit
/// — delete is skill-scoped, not (skill, agent)-scoped).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomDeleteResult {
    pub id: String,
    pub ok: bool,
    pub error: Option<String>,
}

/// Per-skill outcome for the import-from-agent command. Three outcomes:
/// `ok` (copied into the store), `skipped` (already present in the shared store
/// — a linked expert/science/office skill or an already-imported custom one; not
/// an error), or an `error` (not found in the agent, reserved id collision, io).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomImportResult {
    pub id: String,
    pub name: String,
    pub ok: bool,
    pub skipped: bool,
    pub error: Option<String>,
}

// ─── Concurrency ────────────────────────────────────────────────────────

/// Serializes all authoring + link mutations. Non-reentrant (`tokio` Mutex), so
/// batch commands lock once and call the `_locked` inner fns directly.
fn mutation_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

// ─── Paths / agents ─────────────────────────────────────────────────────

fn custom_central_path(id: &str) -> PathBuf {
    central_experts_dir().join(id)
}

fn skill_md_path(id: &str) -> PathBuf {
    custom_central_path(id).join("SKILL.md")
}

fn agent_link_path(agent: AgentType, id: &str) -> Result<PathBuf, CustomSkillsError> {
    let dir = preferred_scope_skill_dir(agent, AgentSkillScope::Global, None)
        .map_err(|_| CustomSkillsError::UnsupportedAgent(agent))?;
    Ok(dir.join(id))
}

/// Every registered agent that supports a skill store. Derived from the registry
/// (not a hardcoded list) so newly-added agents get a matrix column for free.
fn supported_agents() -> Vec<AgentType> {
    all_acp_agents()
        .into_iter()
        .filter(|a| skill_storage_spec(*a).is_some())
        .collect()
}

// ─── Reserved (built-in) ids ────────────────────────────────────────────

/// Union of every bundled pack's ids. A central-store dir with one of these ids
/// belongs to experts/science/office and is never treated as custom.
fn reserved_ids() -> BTreeSet<String> {
    let mut set = BTreeSet::new();
    set.extend(crate::commands::experts::bundled_ids());
    set.extend(crate::commands::science::bundled_ids());
    set.extend(crate::commands::office_tools::bundled_skill_ids());
    set
}

/// Validate an id AND require it to be free of any built-in pack. Used by every
/// authoring mutation (create/save/duplicate/import/delete).
fn ensure_custom_id(raw: &str) -> Result<String, CustomSkillsError> {
    let id = validate_skill_id(raw).map_err(|e| CustomSkillsError::Metadata(e.to_string()))?;
    if reserved_ids().contains(&id) {
        return Err(CustomSkillsError::ReservedId(id));
    }
    Ok(id)
}

/// Turn a free-form name (folder name, frontmatter `name:`) into a valid skill
/// id: lowercased, non-`[a-z0-9._-]` runs collapsed to `-`, edges trimmed.
fn derive_id_from_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut prev_dash = false;
    for ch in name.trim().chars() {
        let c = ch.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() || c == '.' || c == '_' {
            out.push(c);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_matches(['-', '.']).to_string()
}

// ─── Frontmatter name ───────────────────────────────────────────────────

/// Best-effort top-level `name:` scalar from a SKILL.md frontmatter block.
/// (Description reuses acp's tested `read_skill_description`.)
fn read_frontmatter_name(skill_md: &Path) -> Option<String> {
    use std::io::Read;
    let mut file = fs::File::open(skill_md).ok()?;
    let mut buf = [0u8; 4096];
    let n = file.read(&mut buf).ok()?;
    let head = std::str::from_utf8(&buf[..n]).ok()?;

    let mut lines = head.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    for line in lines {
        let trimmed_end = line.trim_end();
        if trimmed_end == "---" || trimmed_end == "..." {
            break;
        }
        // Only a top-level `name:` (no leading whitespace) counts.
        if !line.starts_with(|c: char| c.is_whitespace()) {
            if let Some(rest) = line.strip_prefix("name:") {
                let val = rest
                    .trim()
                    .trim_matches('"')
                    .trim_matches('\'')
                    .trim();
                if !val.is_empty() {
                    return Some(val.to_string());
                }
            }
        }
    }
    None
}

fn build_item(id: String) -> CustomSkillItem {
    let md = skill_md_path(&id);
    let name = read_frontmatter_name(&md).unwrap_or_else(|| id.clone());
    let description = read_skill_description(&md);
    CustomSkillItem {
        central_path: custom_central_path(&id).to_string_lossy().to_string(),
        name,
        description,
        id,
    }
}

/// Scan the central store for custom skill ids (real dir + SKILL.md, id not
/// reserved, not a dotfile). Sync helper shared by list + status snapshot.
fn collect_custom_ids() -> Result<Vec<String>, CustomSkillsError> {
    let central = central_experts_dir();
    let reserved = reserved_ids();
    let mut ids = Vec::new();

    let entries = match fs::read_dir(&central) {
        Ok(e) => e,
        // A missing central store just means "no custom skills yet".
        Err(ref e) if e.kind() == io::ErrorKind::NotFound => return Ok(ids),
        Err(e) => return Err(CustomSkillsError::Io(e.to_string())),
    };

    for entry in entries {
        let entry = entry.map_err(|e| CustomSkillsError::Io(e.to_string()))?;
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();
        // Skip codeg-owned dotfiles (`.manifest.json`, `.manifest.science.json`).
        if name.starts_with('.') {
            continue;
        }
        let id = name.to_string();
        if reserved.contains(&id) {
            continue; // a built-in pack owns this dir
        }
        if validate_skill_id(&id).is_err() {
            continue; // ignore oddly-named dirs rather than fail the whole list
        }
        let path = entry.path();
        if !path.is_dir() || !path.join("SKILL.md").is_file() {
            continue;
        }
        ids.push(id);
    }

    ids.sort();
    Ok(ids)
}

// ─── Commands: list / status / read ─────────────────────────────────────

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn custom_list() -> Result<Vec<CustomSkillItem>, CustomSkillsError> {
    let mut out: Vec<CustomSkillItem> = collect_custom_ids()?.into_iter().map(build_item).collect();
    out.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(out)
}

/// One-shot snapshot of every (custom skill, agent) link state — lets the matrix
/// render the whole grid from a single round-trip.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn custom_list_all_install_statuses() -> Result<Vec<ExpertInstallStatus>, CustomSkillsError>
{
    let ids = collect_custom_ids()?;
    let agents = supported_agents();
    let mut out = Vec::with_capacity(ids.len() * agents.len());
    for id in &ids {
        let expected = custom_central_path(id);
        for &agent in &agents {
            let link_path = match agent_link_path(agent, id) {
                Ok(p) => p,
                Err(_) => continue,
            };
            let state = classify_link(&link_path, &expected);
            let target_path =
                read_link_target(&link_path).map(|p| p.to_string_lossy().to_string());
            out.push(ExpertInstallStatus {
                expert_id: id.clone(),
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

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn custom_read_skill(id: String) -> Result<String, CustomSkillsError> {
    let id = validate_skill_id(&id).map_err(|e| CustomSkillsError::Metadata(e.to_string()))?;
    let path = skill_md_path(&id);
    if !path.is_file() {
        return Err(CustomSkillsError::NotFound(id));
    }
    Ok(fs::read_to_string(&path)?)
}

// ─── Commands: link / unlink / apply ────────────────────────────────────

/// Link one custom skill into one agent's skill dir. **Assumes the mutation lock
/// is already held** — the batch path locks once and calls this directly.
fn link_one_locked(
    id: &str,
    agent_type: AgentType,
) -> Result<ExpertInstallStatus, CustomSkillsError> {
    let id = validate_skill_id(id).map_err(|e| CustomSkillsError::Metadata(e.to_string()))?;
    let central = custom_central_path(&id);
    if !central.exists() {
        return Err(CustomSkillsError::NotFound(id));
    }

    let link_path = agent_link_path(agent_type, &id)?;
    if let Some(parent) = link_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut copy_mode = false;
    match create_link_raw(&central, &link_path) {
        Ok(is_copy) => copy_mode = is_copy,
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
            match classify_link(&link_path, &central) {
                ExpertLinkState::LinkedToCodeg => {} // idempotent success
                ExpertLinkState::BlockedByRealDirectory => {
                    return Err(CustomSkillsError::NameCollision {
                        path: link_path.to_string_lossy().to_string(),
                    });
                }
                ExpertLinkState::LinkedElsewhere | ExpertLinkState::Broken => {
                    let found = read_link_target(&link_path)
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_else(|| "<unknown>".into());
                    return Err(CustomSkillsError::ForeignLink {
                        path: link_path.to_string_lossy().to_string(),
                        found,
                    });
                }
                ExpertLinkState::NotLinked => {
                    create_link_raw(&central, &link_path)
                        .map_err(|e| CustomSkillsError::Io(format!("retry link failed: {e}")))?;
                }
            }
        }
        Err(err) => return Err(CustomSkillsError::Io(err.to_string())),
    }

    let state = classify_link(&link_path, &central);
    let target_path = read_link_target(&link_path).map(|p| p.to_string_lossy().to_string());
    Ok(ExpertInstallStatus {
        expert_id: id.clone(),
        agent_type,
        state,
        link_path: link_path.to_string_lossy().to_string(),
        target_path,
        expected_target_path: central.to_string_lossy().to_string(),
        copy_mode,
    })
}

/// Remove one custom skill's link from one agent's skill dirs. **Assumes the
/// mutation lock is already held.** Scans ALL of the agent's global dirs to
/// handle shared-dir agents (`~/.agents/skills`). Only ever removes OUR links
/// (LinkedToCodeg / Broken) — foreign links and real dirs are left untouched.
fn unlink_one_locked(id: &str, agent_type: AgentType) -> Result<(), CustomSkillsError> {
    let id = validate_skill_id(id).map_err(|e| CustomSkillsError::Metadata(e.to_string()))?;
    let dirs = scoped_skill_dirs(agent_type, AgentSkillScope::Global, None)
        .map_err(|_| CustomSkillsError::UnsupportedAgent(agent_type))?;
    let central = custom_central_path(&id);

    for dir in dirs {
        let candidate = dir.join(&id);
        if !candidate.exists() && !path_is_symlink(&candidate) {
            continue;
        }
        let state = classify_link(&candidate, &central);
        if matches!(
            state,
            ExpertLinkState::LinkedToCodeg | ExpertLinkState::Broken
        ) {
            remove_skill_entry(&candidate).map_err(|e| {
                CustomSkillsError::Io(format!("remove link {}: {e}", candidate.display()))
            })?;
        } else if state == ExpertLinkState::LinkedElsewhere {
            return Err(CustomSkillsError::ForeignLink {
                path: candidate.to_string_lossy().to_string(),
                found: read_link_target(&candidate)
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|| "<unknown>".into()),
            });
        }
        // BlockedByRealDirectory → not ours; leave alone.
    }
    Ok(())
}

/// Apply a batch of enable/disable ops under a single lock. Each op is applied
/// independently: a failing op records `ok: false` and the batch continues. The
/// frontend re-fetches the authoritative snapshot afterward (shared agent dirs
/// make per-op state non-local — see the experts/science shared-dir note).
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn custom_apply_links(ops: Vec<LinkOp>) -> Result<Vec<LinkOpResult>, CustomSkillsError> {
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

// ─── Commands: authoring (create / save / duplicate / import / delete) ───

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn custom_create_skill(
    id: String,
    content: String,
) -> Result<CustomSkillItem, CustomSkillsError> {
    let _guard = mutation_lock().lock().await;
    let id = ensure_custom_id(&id)?;
    let dir = custom_central_path(&id);
    if dir.exists() || path_is_symlink(&dir) {
        return Err(CustomSkillsError::AlreadyExists(id));
    }
    fs::create_dir_all(&dir)?;
    fs::write(dir.join("SKILL.md"), content.as_bytes())?;
    Ok(build_item(id))
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn custom_save_skill(
    id: String,
    content: String,
) -> Result<CustomSkillItem, CustomSkillsError> {
    let _guard = mutation_lock().lock().await;
    let id = ensure_custom_id(&id)?;
    let dir = custom_central_path(&id);
    // Must already exist as a real custom skill dir (never write through a link).
    if path_is_symlink(&dir) {
        return Err(CustomSkillsError::Io(format!(
            "'{id}' is a symlink, not an editable custom skill"
        )));
    }
    if !dir.join("SKILL.md").is_file() {
        return Err(CustomSkillsError::NotFound(id));
    }
    fs::write(dir.join("SKILL.md"), content.as_bytes())?;
    Ok(build_item(id))
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn custom_duplicate_skill(
    source_id: String,
    new_id: String,
) -> Result<CustomSkillItem, CustomSkillsError> {
    let _guard = mutation_lock().lock().await;
    let source_id =
        validate_skill_id(&source_id).map_err(|e| CustomSkillsError::Metadata(e.to_string()))?;
    let source = custom_central_path(&source_id);
    if !source.join("SKILL.md").is_file() {
        return Err(CustomSkillsError::NotFound(source_id));
    }
    let new_id = ensure_custom_id(&new_id)?;
    let dst = custom_central_path(&new_id);
    if dst.exists() || path_is_symlink(&dst) {
        return Err(CustomSkillsError::AlreadyExists(new_id));
    }
    copy_dir_recursive(&source, &dst)?;
    Ok(build_item(new_id))
}

/// Import a skill from disk into the central store. `source_path` may be a
/// directory containing `SKILL.md` (copied whole) or a standalone `.md` file
/// (wrapped as `<id>/SKILL.md`). The id is `id` when given, else derived from
/// the folder/file name.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn custom_import_skill(
    source_path: String,
    id: Option<String>,
) -> Result<CustomSkillItem, CustomSkillsError> {
    let _guard = mutation_lock().lock().await;
    let src = PathBuf::from(source_path.trim());
    if !src.exists() {
        return Err(CustomSkillsError::InvalidSource(format!(
            "path does not exist: {}",
            src.display()
        )));
    }

    // Resolve the target id: explicit arg wins, else the source's own name —
    // the whole folder name for a directory, or the file stem for a bare .md.
    let derived = id.filter(|s| !s.trim().is_empty()).or_else(|| {
        let base = if src.is_dir() {
            src.file_name()
        } else {
            src.file_stem()
        };
        base.map(|s| derive_id_from_name(&s.to_string_lossy()))
    });
    let id = ensure_custom_id(derived.as_deref().unwrap_or(""))?;
    let dst = custom_central_path(&id);
    if dst.exists() || path_is_symlink(&dst) {
        return Err(CustomSkillsError::AlreadyExists(id));
    }

    if src.is_dir() {
        if !src.join("SKILL.md").is_file() {
            return Err(CustomSkillsError::InvalidSource(
                "folder has no SKILL.md".into(),
            ));
        }
        copy_dir_recursive(&src, &dst)?;
    } else if is_markdown(&src) {
        copy_markdown_as_skill(&src, &dst)?;
    } else {
        return Err(CustomSkillsError::InvalidSource(
            "source must be a folder containing SKILL.md, or a .md file".into(),
        ));
    }
    Ok(build_item(id))
}

/// Import one or more of an agent's **own** (global-scope) skills into the shared
/// central store, so they can be re-enabled for any agent from the matrix. Locks
/// once; each id is reported independently (partial success is normal for a
/// multi-select). A skill that is already in the store — e.g. a linked
/// expert/science/office skill, or one imported earlier — is reported as
/// `skipped`, not an error, so re-running is idempotent.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn custom_import_from_agent(
    agent_type: AgentType,
    ids: Vec<String>,
) -> Result<Vec<CustomImportResult>, CustomSkillsError> {
    let _guard = mutation_lock().lock().await;
    let spec = skill_storage_spec(agent_type)
        .ok_or(CustomSkillsError::UnsupportedAgent(agent_type))?;
    Ok(ids
        .iter()
        .map(|id| import_one_from_agent_locked(&spec, id))
        .collect())
}

/// Copy one of an agent's global skills into the central store. Never bubbles —
/// returns a per-skill result so the batch keeps going. **Assumes the mutation
/// lock is held.**
fn import_one_from_agent_locked(spec: &SkillStorageSpec, raw_id: &str) -> CustomImportResult {
    // Resolve the source on disk (a `<id>/` skill dir or a `<id>.md` file) from
    // the agent's GLOBAL skill dirs. Project-scoped skills are workspace-specific
    // and deliberately excluded from the shared store.
    let Some(item) =
        locate_existing_skill_across_dirs(&spec.global_dirs, spec.kind, raw_id, AgentSkillScope::Global)
    else {
        return CustomImportResult {
            id: raw_id.to_string(),
            name: raw_id.to_string(),
            ok: false,
            skipped: false,
            error: Some(format!(
                "skill '{raw_id}' not found in the agent's skill directory"
            )),
        };
    };
    let id = item.id.clone();
    let name = item.name.clone();

    // Already in the shared store? Covers a linked expert/science/office skill
    // (its central dir exists) and a previously-imported custom one. Idempotent
    // skip — not an error.
    let dst = custom_central_path(&id);
    if dst.exists() || path_is_symlink(&dst) {
        return CustomImportResult {
            id,
            name,
            ok: false,
            skipped: true,
            error: None,
        };
    }

    // Guard: refuse ids owned by a built-in pack that somehow aren't extracted
    // yet (rare — built-ins are normally present, so this path is a safety net).
    if let Err(err) = ensure_custom_id(&id) {
        return CustomImportResult {
            id,
            name,
            ok: false,
            skipped: false,
            error: Some(err.to_string()),
        };
    }

    let src = PathBuf::from(&item.path);
    let copied = match item.layout {
        AgentSkillLayout::SkillDirectory => copy_dir_recursive(&src, &dst),
        AgentSkillLayout::MarkdownFile => copy_markdown_as_skill(&src, &dst),
    };
    match copied {
        Ok(()) => CustomImportResult {
            id,
            name,
            ok: true,
            skipped: false,
            error: None,
        },
        Err(err) => {
            // Roll back a partial copy so a retry sees a clean slate (guarded:
            // under the store and not a link).
            if dst.exists() && !path_is_symlink(&dst) && dst.starts_with(central_experts_dir()) {
                let _ = fs::remove_dir_all(&dst);
            }
            CustomImportResult {
                id,
                name,
                ok: false,
                skipped: false,
                error: Some(err.to_string()),
            }
        }
    }
}

/// Wrap a standalone `.md` file as `<dst>/SKILL.md`.
fn copy_markdown_as_skill(src: &Path, dst: &Path) -> Result<(), CustomSkillsError> {
    fs::create_dir_all(dst)?;
    fs::copy(src, dst.join("SKILL.md"))?;
    Ok(())
}

/// Batch-delete custom skills. For each id: first unlink from **every** agent
/// (symlink-safe — foreign links are left in place), then remove the real
/// central directory. Locks once; per-skill failures are reported, not fatal.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn custom_delete_skills(
    ids: Vec<String>,
) -> Result<Vec<CustomDeleteResult>, CustomSkillsError> {
    let _guard = mutation_lock().lock().await;
    let agents = supported_agents();
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        let res = delete_one_locked(&id, &agents);
        out.push(match res {
            Ok(()) => CustomDeleteResult {
                id,
                ok: true,
                error: None,
            },
            Err(err) => CustomDeleteResult {
                id,
                ok: false,
                error: Some(err.to_string()),
            },
        });
    }
    Ok(out)
}

fn delete_one_locked(id: &str, agents: &[AgentType]) -> Result<(), CustomSkillsError> {
    let id = ensure_custom_id(id)?;
    // 1) Detach from every agent. A foreign link at the same path isn't ours, so
    // tolerate it rather than aborting the delete.
    for &agent in agents {
        match unlink_one_locked(&id, agent) {
            Ok(()) => {}
            Err(CustomSkillsError::ForeignLink { .. })
            | Err(CustomSkillsError::UnsupportedAgent(_)) => {}
            Err(e) => return Err(e),
        }
    }
    // 2) Remove the real central directory (guarded: under the store, not a link).
    let central = custom_central_path(&id);
    if path_is_symlink(&central) {
        // Never remove_dir_all through a link — just detach it.
        remove_skill_entry(&central)?;
    } else if central.exists() {
        let root = central_experts_dir();
        if !central.starts_with(&root) {
            return Err(CustomSkillsError::Io(
                "refusing to delete outside the central store".into(),
            ));
        }
        fs::remove_dir_all(&central).map_err(|e| CustomSkillsError::Io(e.to_string()))?;
    }
    Ok(())
}

// ─── Filesystem helpers ─────────────────────────────────────────────────

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
        .unwrap_or(false)
}

/// Cross-platform recursive copy (experts' own copy is Windows-only). Symlinks
/// encountered inside a source tree are followed and copied as regular files.
fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), CustomSkillsError> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

// ─── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::{timeout, Duration};

    // Uses ids that are well-formed but absent from the central store, so the
    // link tests never mutate the developer's real skill directories.

    #[test]
    fn reserved_ids_include_known_bundled() {
        let reserved = reserved_ids();
        assert!(reserved.contains("brainstorming"), "experts id missing");
        assert!(!reserved.is_empty());
    }

    #[test]
    fn ensure_custom_id_rejects_reserved() {
        let err = ensure_custom_id("brainstorming").unwrap_err();
        assert!(matches!(err, CustomSkillsError::ReservedId(_)), "{err:?}");
    }

    #[test]
    fn ensure_custom_id_accepts_free_id() {
        assert_eq!(
            ensure_custom_id("  my-custom-skill  ").unwrap(),
            "my-custom-skill"
        );
    }

    #[test]
    fn derive_id_from_name_sanitizes() {
        assert_eq!(derive_id_from_name("My Cool Skill!"), "my-cool-skill");
        assert_eq!(derive_id_from_name("already-ok"), "already-ok");
        assert_eq!(derive_id_from_name("  --Trim.Me--  "), "trim.me");
        assert_eq!(derive_id_from_name("snake_case_1"), "snake_case_1");
    }

    #[test]
    fn is_markdown_detects_md() {
        assert!(is_markdown(Path::new("a/b/SKILL.md")));
        assert!(is_markdown(Path::new("x.MARKDOWN")));
        assert!(!is_markdown(Path::new("x.txt")));
        assert!(!is_markdown(Path::new("noext")));
    }

    #[test]
    fn supported_agents_are_nonempty_and_skill_capable() {
        let agents = supported_agents();
        assert!(!agents.is_empty());
        assert!(agents.iter().all(|a| skill_storage_spec(*a).is_some()));
    }

    #[test]
    fn a_custom_agent_joins_the_matrix_by_declaring_a_store() {
        use crate::acp::custom_registry::{
            hydrate, hydrate_test_guard, CustomAgentDef, CustomAgentSpec, CustomDistributionKind,
            NpxSpec,
        };
        let _guard = hydrate_test_guard();
        let mut def = CustomAgentDef {
            registry_id: "skills-matrix-agent".into(),
            name: "Skills Matrix Agent".into(),
            description: String::new(),
            version: "1.0.0".into(),
            distribution_kind: CustomDistributionKind::Npx,
            spec: CustomAgentSpec {
                npx: Some(NpxSpec {
                    package: "skills-matrix-agent@1.0.0".into(),
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
        let agent = crate::models::agent::AgentType::custom("skills-matrix-agent").unwrap();
        // Absolute on every platform — a unix literal would not be on Windows.
        let dedicated = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("codeg-dedicated-skills");

        assert!(hydrate(std::slice::from_ref(&def)).is_empty());
        assert!(
            skill_storage_spec(agent).is_none(),
            "undeclared custom agents expose no skill store"
        );
        assert!(!supported_agents().contains(&agent));

        // Shared store alone: exactly the `.agents/skills` convention, global
        // and project-local, nothing agent-specific to list first.
        def.skills_shared_store = true;
        assert!(hydrate(std::slice::from_ref(&def)).is_empty());
        let spec = skill_storage_spec(agent).expect("declared agent joins the matrix");
        assert!(supported_agents().contains(&agent));
        assert_eq!(spec.project_rel_dirs, vec![".agents/skills"]);
        assert_eq!(spec.global_dirs.len(), 1);
        assert!(spec.global_dirs[0].ends_with(".agents/skills"));

        // A dedicated directory alone is an equally valid way in; it has no
        // project-local convention to offer.
        def.skills_shared_store = false;
        def.skills_dir = Some(dedicated.to_string_lossy().into_owned());
        assert!(hydrate(std::slice::from_ref(&def)).is_empty());
        let spec = skill_storage_spec(agent).expect("a dedicated dir joins the matrix too");
        assert!(supported_agents().contains(&agent));
        assert_eq!(spec.global_dirs, vec![dedicated.clone()]);
        assert!(spec.project_rel_dirs.is_empty());

        // Both: the dedicated directory is listed first so linking targets it
        // without side effects on the shared store (the pi/Cursor ordering).
        def.skills_shared_store = true;
        assert!(hydrate(std::slice::from_ref(&def)).is_empty());
        let spec = skill_storage_spec(agent).expect("both declarations compose");
        assert_eq!(spec.global_dirs.len(), 2);
        assert_eq!(spec.global_dirs[0], dedicated);
        assert!(spec.global_dirs[1].ends_with(".agents/skills"));
        assert_eq!(spec.project_rel_dirs, vec![".agents/skills"]);

        // A non-absolute stored value (hand-edited database) is ignored
        // rather than resolved against the working directory.
        def.skills_shared_store = false;
        def.skills_dir = Some("relative/skills".into());
        assert!(hydrate(std::slice::from_ref(&def)).is_empty());
        assert!(skill_storage_spec(agent).is_none());

        assert!(hydrate(&[]).is_empty());
        assert!(skill_storage_spec(agent).is_none());
    }

    #[tokio::test]
    async fn apply_links_does_not_deadlock() {
        let ops = vec![
            LinkOp {
                expert_id: "zzz-codeg-custom-batch-absent-aaa".into(),
                agent_type: AgentType::ClaudeCode,
                enable: false,
            },
            LinkOp {
                expert_id: "zzz-codeg-custom-batch-absent-bbb".into(),
                agent_type: AgentType::Codex,
                enable: false,
            },
        ];
        let results = timeout(Duration::from_secs(5), custom_apply_links(ops))
            .await
            .expect("custom_apply_links must not deadlock")
            .expect("batch returns Ok");
        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|r| r.ok), "{results:?}");
    }

    #[tokio::test]
    async fn apply_links_collects_per_op_results_without_aborting() {
        let ops = vec![
            LinkOp {
                // Idempotent disable of an absent link → ok.
                expert_id: "zzz-codeg-custom-batch-absent".into(),
                agent_type: AgentType::ClaudeCode,
                enable: false,
            },
            LinkOp {
                // Enable of a skill with no central copy → fails its op.
                expert_id: "zzz-codeg-custom-not-installed".into(),
                agent_type: AgentType::ClaudeCode,
                enable: true,
            },
        ];
        let results = custom_apply_links(ops).await.expect("batch returns Ok");
        assert_eq!(results.len(), 2);
        assert!(results[0].ok, "idempotent disable should succeed");
        assert!(!results[1].ok, "enable of missing central skill should fail");
        assert!(results[1].error.is_some());
        assert!(results[1].status.is_none());
    }

    #[tokio::test]
    async fn delete_absent_skills_report_per_id() {
        // Deleting ids with no central dir + no links is an idempotent success;
        // this never touches real content.
        let results = custom_delete_skills(vec![
            "zzz-codeg-custom-delete-absent-1".into(),
            "zzz-codeg-custom-delete-absent-2".into(),
        ])
        .await
        .expect("batch returns Ok");
        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|r| r.ok), "{results:?}");
    }

    #[tokio::test]
    async fn create_and_save_reject_reserved_ids() {
        let created = custom_create_skill("writing-plans".into(), "x".into()).await;
        assert!(matches!(
            created,
            Err(CustomSkillsError::ReservedId(_))
        ));
        let saved = custom_save_skill("writing-plans".into(), "x".into()).await;
        assert!(matches!(saved, Err(CustomSkillsError::ReservedId(_))));
    }

    #[tokio::test]
    async fn import_from_agent_reports_missing_ids_without_mutating() {
        // Ids that don't exist in any real agent skill dir → each op fails to
        // locate a source and is reported (never touches real content).
        let results = custom_import_from_agent(
            AgentType::ClaudeCode,
            vec![
                "zzz-codeg-custom-import-absent-1".into(),
                "zzz-codeg-custom-import-absent-2".into(),
            ],
        )
        .await
        .expect("batch returns Ok");
        assert_eq!(results.len(), 2);
        assert!(
            results.iter().all(|r| !r.ok && !r.skipped && r.error.is_some()),
            "{results:?}"
        );
    }

    #[tokio::test]
    // The hydrate guard is held across awaits on purpose — see the identical
    // note in `custom_agent_service`: it is a test-only mutex no production
    // code takes, and `#[tokio::test]` runs this on a single-threaded runtime.
    #[allow(clippy::await_holding_lock)]
    async fn list_all_install_statuses_is_wellformed() {
        // A row per custom skill and skill-capable agent, and both halves are
        // process-global: a test hydrating a custom agent that declares a store
        // adds a column mid-snapshot, and the fs-mutation tests below point
        // HOME at a temp tree of their own, which swaps the rows. So the
        // registry is held still, and HOME is read under `temp_env`'s lock
        // with nothing changed.
        let _guard = crate::acp::custom_registry::hydrate_test_guard();
        let unchanged: [(&str, Option<&str>); 0] = [];
        let (ids, agents, rows) = temp_env::async_with_vars(unchanged, async {
            let rows = custom_list_all_install_statuses()
                .await
                .expect("snapshot returns Ok");
            (collect_custom_ids().expect("ids"), supported_agents(), rows)
        })
        .await;
        assert_eq!(rows.len(), ids.len() * agents.len());
        for id in &ids {
            for agent in &agents {
                assert!(
                    rows.iter()
                        .any(|row| &row.expert_id == id && row.agent_type == *agent),
                    "no row for {id} × {agent:?}"
                );
            }
        }
    }

    #[test]
    fn validate_skill_id_rejects_traversal_and_separators() {
        // The load-bearing sanitizer every authoring path funnels through.
        for bad in ["", "  ", "..", "../x", "a/b", "a\\b", ".hidden", "a:b", "a b"] {
            assert!(validate_skill_id(bad).is_err(), "must reject {bad:?}");
        }
        for good in ["my-skill", "a.b_c-1", "Skill123"] {
            assert!(validate_skill_id(good).is_ok(), "must accept {good:?}");
        }
    }

    // ─── fs-mutation integration tests ──────────────────────────────────────
    //
    // These exercise the REAL create/save/duplicate/import/delete paths against
    // a throwaway `$HOME`, so `central_experts_dir()` and the agent link dirs
    // resolve inside a temp tree. `dirs::home_dir()` ignores `$HOME` on Windows
    // (see the skill-storage spec tests), so they are unix-gated; the logic
    // under test (id validation, unlink-before-delete ordering, recursive copy)
    // is platform-independent. `temp_env` serializes the HOME mutation against
    // other env-mutating tests via its own global lock.
    #[cfg(unix)]
    async fn with_temp_home<F, Fut, R>(body: F) -> R
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = R>,
    {
        let tmp = tempfile::tempdir().expect("tempdir");
        // The future is built now but only polled (its fs ops run) after
        // `async_with_vars` has pinned HOME. `tmp` outlives the await, then drops.
        temp_env::async_with_vars([("HOME", Some(tmp.path()))], body()).await
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fs_roundtrip_create_read_save_delete() {
        with_temp_home(|| async {
            let id = "my-fs-roundtrip";
            let content = "---\nname: My FS Roundtrip\ndescription: t\n---\nbody\n";
            custom_create_skill(id.into(), content.into())
                .await
                .expect("create");

            let md = central_experts_dir().join(id).join("SKILL.md");
            assert!(md.is_file(), "SKILL.md should exist after create");
            assert_eq!(fs::read_to_string(&md).unwrap(), content);
            assert_eq!(
                custom_read_skill(id.into()).await.expect("read"),
                content,
                "read must round-trip the created content"
            );

            let updated = "---\nname: My FS Roundtrip\n---\nnew body\n";
            custom_save_skill(id.into(), updated.into())
                .await
                .expect("save");
            assert_eq!(fs::read_to_string(&md).unwrap(), updated);

            let dir = central_experts_dir().join(id);
            let results = custom_delete_skills(vec![id.into()])
                .await
                .expect("delete batch");
            assert!(results.iter().all(|r| r.ok), "{results:?}");
            assert!(!dir.exists(), "central dir must be gone after delete");
        })
        .await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fs_delete_unlinks_agent_before_removing_central() {
        with_temp_home(|| async {
            let id = "my-linked-skill";
            custom_create_skill(id.into(), "---\nname: L\n---\nx\n".into())
                .await
                .expect("create");

            let res = custom_apply_links(vec![LinkOp {
                expert_id: id.into(),
                agent_type: AgentType::ClaudeCode,
                enable: true,
            }])
            .await
            .expect("apply batch");
            assert!(res[0].ok, "link enable should succeed: {res:?}");

            let link = agent_link_path(AgentType::ClaudeCode, id).expect("link path");
            assert!(path_is_symlink(&link), "agent link should exist after enable");

            let dir = central_experts_dir().join(id);
            let del = custom_delete_skills(vec![id.into()])
                .await
                .expect("delete batch");
            assert!(del[0].ok, "{del:?}");
            assert!(
                !path_is_symlink(&link) && !link.exists(),
                "agent link must be removed (unlink-before-delete)"
            );
            assert!(!dir.exists(), "central dir must be removed after unlinking");
        })
        .await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fs_duplicate_and_import() {
        with_temp_home(|| async {
            custom_create_skill("orig-skill".into(), "---\nname: O\n---\nbody\n".into())
                .await
                .expect("create orig");
            custom_duplicate_skill("orig-skill".into(), "copy-skill".into())
                .await
                .expect("duplicate");
            assert!(
                central_experts_dir()
                    .join("copy-skill")
                    .join("SKILL.md")
                    .is_file(),
                "duplicate must copy SKILL.md into the store"
            );

            // Import a bare `.md` file (wrapped as <id>/SKILL.md).
            let src = tempfile::tempdir().expect("src tmp");
            let src_md = src.path().join("imported.md");
            fs::write(&src_md, "---\nname: Imported\n---\nz\n").unwrap();
            custom_import_skill(src_md.to_string_lossy().into_owned(), None)
                .await
                .expect("import md");
            assert!(central_experts_dir()
                .join("imported")
                .join("SKILL.md")
                .is_file());

            // Import a directory containing SKILL.md (copied whole).
            let src_dir = src.path().join("dir-skill");
            fs::create_dir_all(&src_dir).unwrap();
            fs::write(src_dir.join("SKILL.md"), "---\nname: Dir\n---\nq\n").unwrap();
            custom_import_skill(
                src_dir.to_string_lossy().into_owned(),
                Some("dir-skill".into()),
            )
            .await
            .expect("import dir");
            assert!(central_experts_dir()
                .join("dir-skill")
                .join("SKILL.md")
                .is_file());
        })
        .await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fs_rejects_path_traversal_ids() {
        with_temp_home(|| async {
            // A sentinel OUTSIDE the store (directly under $HOME) that a `..`
            // escape would target; it must survive every rejected op.
            let store = central_experts_dir();
            fs::create_dir_all(&store).unwrap();
            let sentinel = store.parent().unwrap().join("SENTINEL.md");
            fs::write(&sentinel, "keep me").unwrap();

            for bad in ["../SENTINEL", "..", "/etc/passwd", "a/b", ".hidden"] {
                assert!(
                    custom_create_skill(bad.into(), "x".into()).await.is_err(),
                    "create must reject {bad:?}"
                );
                assert!(
                    custom_save_skill(bad.into(), "x".into()).await.is_err(),
                    "save must reject {bad:?}"
                );
            }

            // Batch delete reports each bad id as a validation failure (never a
            // successful escape).
            let del = custom_delete_skills(
                ["../SENTINEL", "..", "/etc/passwd"]
                    .iter()
                    .map(|s| s.to_string())
                    .collect(),
            )
            .await
            .expect("batch returns Ok");
            assert!(
                del.iter().all(|r| !r.ok && r.error.is_some()),
                "{del:?}"
            );

            assert!(sentinel.is_file(), "sentinel outside the store must survive");
            assert_eq!(fs::read_to_string(&sentinel).unwrap(), "keep me");
        })
        .await;
    }
}
