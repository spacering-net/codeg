//! Custom (user-authored) skills management.
//!
//! The fourth "skill pack" in codeg's central store `~/.codeg/skills/<id>/`.
//! Unlike experts/science/office — which bundle *read-only* content into the
//! binary — custom skills are created, edited, imported and deleted by the
//! user. They live in the SAME central store and are enabled for an ACP agent
//! the SAME way (a symlink, or Windows junction, from the agent's skill dir
//! into the central copy), through the skills engine (`crate::skills`), so the
//! matrix UI renders them identically.
//!
//! **Identity by provenance.** A "custom skill" is any directory in the central
//! store that holds a `SKILL.md` and that no manifest claims (the packs'
//! manifests, the UI pack's marker, the Harness manifest — see
//! `skills::provenance`). Dot-prefixed folders (`.user-backups`,
//! `.codeg-staging`) and an older release's `<id>.user-backup-<time>` backups
//! are never skills. A user can still drop a folder into `~/.codeg/skills` and
//! have it appear on refresh.
//!
//! Every write — create, save, duplicate, import, delete, links — happens under
//! the skills lock; a new skill is written into staging in full and renamed
//! into place, and `SKILL.md` is replaced in one step, so nothing is ever half
//! there.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::acp::types::{AgentSkillLayout, AgentSkillScope};
use crate::app_error::AppCommandError;
#[cfg(test)]
use crate::commands::acp::skill_storage_spec;
use crate::commands::acp::{
    locate_existing_skill_across_dirs, read_skill_description, validate_skill_id, SkillStorageKind,
};
use crate::commands::experts::{central_experts_dir, ExpertInstallStatus, LinkOp, LinkOpResult};
use crate::models::agent::AgentType;
use crate::skills::fsio::{copy_markdown_as_skill, copy_tree, write_content_atomic};
use crate::skills::model::{codes, ChangedKind, SkillOrigin};
use crate::skills::packs::place_skill;
use crate::skills::{legacy, SkillsCtx};
use crate::web::event_bridge::EventEmitter;

// ─── Error type ─────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum CustomSkillsError {
    #[error("custom skill not found: {0}")]
    NotFound(String),
    #[error("a skill with id '{0}' already exists")]
    AlreadyExists(String),
    #[error("'{0}' is a built-in skill id and can't be used for a custom skill")]
    ReservedId(String),
    /// The store's skill of that id is claimed by a manifest that is not a
    /// pack's (Harness's): it is not a Custom skill to edit or delete.
    #[error(
        "'{id}' is a {origin} skill, not a custom one; copy it into a custom skill to change it"
    )]
    Claimed { id: String, origin: &'static str },
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
    /// The skills lock could not be taken.
    #[error("{message}")]
    Locked { code: &'static str, message: String },
    /// Whose the store's skill of that id is cannot be told (Harness's
    /// manifest cannot be read): it is left as it is.
    #[error("Codeg cannot tell whether '{id}' is a {origin} skill (its record cannot be read); it is left as it is")]
    Unresolved { id: String, origin: &'static str },
}

impl CustomSkillsError {
    pub fn code(&self) -> &'static str {
        match self {
            CustomSkillsError::NotFound(_) => codes::NOT_FOUND,
            CustomSkillsError::AlreadyExists(_) => codes::ID_TAKEN,
            CustomSkillsError::ReservedId(_) | CustomSkillsError::Claimed { .. } => {
                codes::ID_RESERVED
            }
            CustomSkillsError::UnsupportedAgent(_) => codes::AGENT_UNSUPPORTED,
            CustomSkillsError::NameCollision { .. } => codes::TARGET_OCCUPIED,
            CustomSkillsError::ForeignLink { .. } => codes::TARGET_LINKED_ELSEWHERE,
            CustomSkillsError::InvalidSource(_) => codes::INVALID_SOURCE,
            CustomSkillsError::Io(_) => codes::IO_ERROR,
            CustomSkillsError::Metadata(_) => codes::SKILL_INVALID,
            CustomSkillsError::Locked { code, .. } => code,
            CustomSkillsError::Unresolved { .. } => codes::OWNERSHIP_UNRESOLVED,
        }
    }
}

impl From<&CustomSkillsError> for AppCommandError {
    fn from(error: &CustomSkillsError) -> Self {
        let base = match error {
            CustomSkillsError::NotFound(_) => AppCommandError::not_found(error.to_string()),
            CustomSkillsError::AlreadyExists(_) => {
                AppCommandError::already_exists(error.to_string())
            }
            CustomSkillsError::ReservedId(_)
            | CustomSkillsError::Claimed { .. }
            | CustomSkillsError::Unresolved { .. }
            | CustomSkillsError::Metadata(_)
            | CustomSkillsError::InvalidSource(_) => {
                AppCommandError::invalid_input(error.to_string())
            }
            _ => AppCommandError::task_execution_failed(error.to_string()),
        };
        let detail = match error {
            CustomSkillsError::Claimed { origin, .. }
            | CustomSkillsError::Unresolved { origin, .. } => Some(origin.to_string()),
            _ => None,
        };
        crate::skills::coded_error(base, error.code(), detail)
    }
}

/// On both transports an error is an `AppCommandError` with its stable code.
impl Serialize for CustomSkillsError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        AppCommandError::from(self).serialize(serializer)
    }
}

impl From<io::Error> for CustomSkillsError {
    fn from(err: io::Error) -> Self {
        CustomSkillsError::Io(err.to_string())
    }
}

impl From<crate::skills::lock::SkillsLockError> for CustomSkillsError {
    fn from(err: crate::skills::lock::SkillsLockError) -> Self {
        CustomSkillsError::Locked {
            code: err.code(),
            message: err.to_string(),
        }
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
    /// The failure's stable code; `None` on success.
    pub code: Option<String>,
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
    /// The failure's stable code; `None` on success and on a skip.
    pub code: Option<String>,
}

// ─── Paths / agents ─────────────────────────────────────────────────────

fn skill_md_path(id: &str) -> PathBuf {
    central_experts_dir().join(id).join("SKILL.md")
}

/// Where enabling `id` for `agent` puts the link: the agent's own skill
/// directory when it has one (the engine's choice).
#[cfg(test)]
fn agent_link_path(agent: AgentType, id: &str) -> Result<PathBuf, CustomSkillsError> {
    SkillsCtx::user()
        .link_dir(agent)
        .map(|(dir, _)| dir.join(id))
        .ok_or(CustomSkillsError::UnsupportedAgent(agent))
}

/// Every registered agent that supports a skill store — the matrix's columns
/// (`SkillsCtx::agents` is the same list).
#[cfg(test)]
fn supported_agents() -> Vec<AgentType> {
    crate::acp::registry::all_acp_agents()
        .into_iter()
        .filter(|a| skill_storage_spec(*a).is_some())
        .collect()
}

// ─── Reserved (built-in) ids ────────────────────────────────────────────

/// Validate a NEW id against the store at `store`: free of every bundled
/// pack's ids (whether or not the pack is extracted yet), and of the UI
/// pack's while that store holds Codeg's marked copy.
pub(crate) fn ensure_custom_id_in(store: &Path, raw: &str) -> Result<String, CustomSkillsError> {
    use crate::skills::provenance::{UI_IDS, UI_MARKER};
    let id = validate_skill_id(raw).map_err(|e| CustomSkillsError::Metadata(e.to_string()))?;
    let bundled = crate::commands::experts::bundled_ids()
        .into_iter()
        .chain(crate::commands::science::bundled_ids())
        .chain(crate::commands::office_tools::bundled_skill_ids())
        .any(|reserved| reserved == id);
    let ui = UI_IDS.contains(&id.as_str()) && store.join(&id).join(UI_MARKER).is_file();
    if bundled || ui {
        return Err(CustomSkillsError::ReservedId(id));
    }
    Ok(id)
}

/// Validate the id of an EXISTING skill a Custom command is about to change
/// or delete, by whose it actually is — under the skills lock, from the
/// store's manifests and markers (`skills::provenance`), never by the name
/// alone: a skill of the user's that a pack later bundled the id of is still
/// theirs to edit and delete, and a skill a manifest claims (a pack's,
/// Harness's) is not, whatever its id. An id the store does not have (and
/// nothing claims) falls back to the rule for new ids.
fn ensure_custom_skill_in(store: &Path, raw: &str) -> Result<String, CustomSkillsError> {
    let id = validate_skill_id(raw).map_err(|e| CustomSkillsError::Metadata(e.to_string()))?;
    let provenance = crate::skills::provenance::Provenance::load(store);
    if provenance.harness_unresolved(&id) {
        return Err(CustomSkillsError::Unresolved {
            id,
            origin: SkillOrigin::Harness.as_str(),
        });
    }
    let present = fs::symlink_metadata(store.join(&id)).is_ok();
    if !present && provenance.claimed(&id).is_none() {
        return ensure_custom_id_in(store, &id);
    }
    match provenance.origin_of(store, &id) {
        Some(SkillOrigin::Custom) => Ok(id),
        Some(SkillOrigin::Harness) => Err(CustomSkillsError::Claimed {
            id,
            origin: SkillOrigin::Harness.as_str(),
        }),
        Some(_) => Err(CustomSkillsError::ReservedId(id)),
        // Something under that name that is not a skill at all (a file, a
        // folder without `SKILL.md`, an older release's backup).
        None => Err(CustomSkillsError::NotFound(id)),
    }
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
pub(crate) fn read_frontmatter_name(skill_md: &Path) -> Option<String> {
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
                let val = rest.trim().trim_matches('"').trim_matches('\'').trim();
                if !val.is_empty() {
                    return Some(val.to_string());
                }
            }
        }
    }
    None
}

fn build_item(store: &Path, id: String) -> CustomSkillItem {
    let dir = store.join(&id);
    let md = dir.join("SKILL.md");
    let name = read_frontmatter_name(&md).unwrap_or_else(|| id.clone());
    let description = read_skill_description(&md);
    CustomSkillItem {
        central_path: dir.to_string_lossy().to_string(),
        name,
        description,
        id,
    }
}

/// The store's Custom skills: those no manifest claims.
fn collect_custom_ids(central: &Path) -> Result<Vec<String>, CustomSkillsError> {
    match fs::read_dir(central) {
        Ok(_) => {}
        // A missing central store just means "no custom skills yet".
        Err(ref e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(CustomSkillsError::Io(e.to_string())),
    }
    let provenance = crate::skills::provenance::Provenance::load(central);
    Ok(
        crate::skills::provenance::store_skills(central, &provenance)
            .into_iter()
            .filter(|(_, origin)| *origin == SkillOrigin::Custom)
            .map(|(id, _)| id)
            .collect(),
    )
}

/// Run `work` under the skills lock of `ctx`, off the async workers.
async fn under_lock<T: Send + 'static>(
    ctx: SkillsCtx,
    work: impl FnOnce(&SkillsCtx) -> Result<T, CustomSkillsError> + Send + 'static,
) -> Result<T, CustomSkillsError> {
    let guard = ctx.lock().await?;
    tokio::task::spawn_blocking(move || {
        let _guard = guard;
        work(&ctx)
    })
    .await
    .map_err(|e| CustomSkillsError::Io(format!("join error: {e}")))?
}

fn announce_store(emitter: &EventEmitter, agents: Vec<AgentType>) {
    crate::skills::announce(emitter, [ChangedKind::Store], agents);
}

// ─── Commands: list / status / read ─────────────────────────────────────

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn custom_list() -> Result<Vec<CustomSkillItem>, CustomSkillsError> {
    let store = central_experts_dir();
    let mut out: Vec<CustomSkillItem> = collect_custom_ids(&store)?
        .into_iter()
        .map(|id| build_item(&store, id))
        .collect();
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
pub async fn custom_list_all_install_statuses(
) -> Result<Vec<ExpertInstallStatus>, CustomSkillsError> {
    custom_list_all_install_statuses_in(SkillsCtx::user()).await
}

/// [`custom_list_all_install_statuses`] over the store and agents of `ctx`.
pub(crate) async fn custom_list_all_install_statuses_in(
    ctx: SkillsCtx,
) -> Result<Vec<ExpertInstallStatus>, CustomSkillsError> {
    tokio::task::spawn_blocking(move || {
        let ids = collect_custom_ids(&ctx.store)?;
        let agents: Vec<AgentType> = ctx.agents.iter().map(|a| a.agent).collect();
        Ok(legacy::statuses(&ctx, SkillOrigin::Custom, &ids, &agents))
    })
    .await
    .map_err(|e| CustomSkillsError::Io(format!("join error: {e}")))?
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

/// Apply a batch of enable/disable ops under the skills lock. Each op is
/// applied independently: a failing op records `ok: false` (with a code) and
/// the batch continues. See `experts_apply_links_core` for what is refused
/// here and done on the Harness page instead.
pub async fn custom_apply_links_core(
    emitter: &EventEmitter,
    ops: Vec<LinkOp>,
) -> Result<Vec<LinkOpResult>, CustomSkillsError> {
    custom_apply_links_in(SkillsCtx::user(), emitter, ops).await
}

/// [`custom_apply_links_core`] over the store and agents of `ctx`.
pub(crate) async fn custom_apply_links_in(
    ctx: SkillsCtx,
    emitter: &EventEmitter,
    ops: Vec<LinkOp>,
) -> Result<Vec<LinkOpResult>, CustomSkillsError> {
    let guard = match ctx.lock().await {
        Ok(guard) => guard,
        Err(err) => return Ok(legacy::busy(&ops, &err)),
    };
    let task_ctx = ctx.clone();
    let (results, changed) = tokio::task::spawn_blocking(move || {
        let _guard = guard;
        legacy::apply_ops(&task_ctx, SkillOrigin::Custom, &ops, |_, _| None)
    })
    .await
    .map_err(|e| CustomSkillsError::Io(format!("join error: {e}")))?;
    if !changed.dirs.is_empty() {
        crate::skills::announce(emitter, [ChangedKind::Links], changed.agents(&ctx));
    }
    Ok(results)
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn custom_apply_links(
    ops: Vec<LinkOp>,
    app: tauri::AppHandle,
) -> Result<Vec<LinkOpResult>, CustomSkillsError> {
    custom_apply_links_core(&EventEmitter::from_app(&app), ops).await
}

// ─── Commands: authoring (create / save / duplicate / import / delete) ───

pub async fn custom_create_skill_core(
    emitter: &EventEmitter,
    id: String,
    content: String,
) -> Result<CustomSkillItem, CustomSkillsError> {
    custom_create_skill_in(SkillsCtx::user(), emitter, id, content).await
}

/// [`custom_create_skill_core`] into the store of `ctx`.
pub(crate) async fn custom_create_skill_in(
    ctx: SkillsCtx,
    emitter: &EventEmitter,
    id: String,
    content: String,
) -> Result<CustomSkillItem, CustomSkillsError> {
    let item = under_lock(ctx, move |ctx| {
        let id = ensure_custom_id_in(&ctx.store, &id)?;
        if fs::symlink_metadata(ctx.skill_path(&id)).is_ok() {
            return Err(CustomSkillsError::AlreadyExists(id));
        }
        place_skill(ctx, &id, false, |target| {
            fs::create_dir_all(target)?;
            fs::write(target.join("SKILL.md"), content.as_bytes())
        })?;
        Ok(build_item(&ctx.store, id))
    })
    .await?;
    announce_store(emitter, Vec::new());
    Ok(item)
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn custom_create_skill(
    id: String,
    content: String,
    app: tauri::AppHandle,
) -> Result<CustomSkillItem, CustomSkillsError> {
    custom_create_skill_core(&EventEmitter::from_app(&app), id, content).await
}

pub async fn custom_save_skill_core(
    emitter: &EventEmitter,
    id: String,
    content: String,
) -> Result<CustomSkillItem, CustomSkillsError> {
    custom_save_skill_in(SkillsCtx::user(), emitter, id, content).await
}

/// [`custom_save_skill_core`] in the store of `ctx`. Only a Custom skill —
/// by whose it is, not by its id — is saved.
pub(crate) async fn custom_save_skill_in(
    ctx: SkillsCtx,
    emitter: &EventEmitter,
    id: String,
    content: String,
) -> Result<CustomSkillItem, CustomSkillsError> {
    let (item, agents) = under_lock(ctx, move |ctx| {
        let id = ensure_custom_skill_in(&ctx.store, &id)?;
        let dir = ctx.skill_path(&id);
        // Must already exist as a real custom skill dir (never write through a link).
        if fs::symlink_metadata(&dir).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(CustomSkillsError::Io(format!(
                "'{id}' is a symlink, not an editable custom skill"
            )));
        }
        if !dir.join("SKILL.md").is_file() {
            return Err(CustomSkillsError::NotFound(id));
        }
        write_content_atomic(&dir.join("SKILL.md"), content.as_bytes())?;
        // Codeg's copies of it that nobody changed follow the edit.
        for problem in crate::skills::packs::refresh_copies(ctx, &id) {
            tracing::warn!("[Custom] {problem}");
        }
        let agents = crate::skills::world::World::load(ctx).seen_by(&id);
        Ok((build_item(&ctx.store, id), agents))
    })
    .await?;
    announce_store(emitter, agents);
    Ok(item)
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn custom_save_skill(
    id: String,
    content: String,
    app: tauri::AppHandle,
) -> Result<CustomSkillItem, CustomSkillsError> {
    custom_save_skill_core(&EventEmitter::from_app(&app), id, content).await
}

pub async fn custom_duplicate_skill_core(
    emitter: &EventEmitter,
    source_id: String,
    new_id: String,
) -> Result<CustomSkillItem, CustomSkillsError> {
    custom_duplicate_skill_in(SkillsCtx::user(), emitter, source_id, new_id).await
}

/// [`custom_duplicate_skill_core`] in the store of `ctx`. The source may be
/// any skill in the store — a pack's, Harness's, a Custom one ("copy as
/// Custom") — and the copy is a Custom skill under the new, free id: it
/// carries no claim of the source's (no pack's marker), and no manifest
/// lists it.
pub(crate) async fn custom_duplicate_skill_in(
    ctx: SkillsCtx,
    emitter: &EventEmitter,
    source_id: String,
    new_id: String,
) -> Result<CustomSkillItem, CustomSkillsError> {
    let item = under_lock(ctx, move |ctx| {
        let source_id = validate_skill_id(&source_id)
            .map_err(|e| CustomSkillsError::Metadata(e.to_string()))?;
        let source = ctx.skill_path(&source_id);
        if !source.join("SKILL.md").is_file() {
            return Err(CustomSkillsError::NotFound(source_id));
        }
        let new_id = ensure_custom_id_in(&ctx.store, &new_id)?;
        if fs::symlink_metadata(ctx.skill_path(&new_id)).is_ok() {
            return Err(CustomSkillsError::AlreadyExists(new_id));
        }
        place_skill(ctx, &new_id, false, |target| {
            copy_tree(&source, target)?;
            drop_ownership_marker(target)
        })?;
        Ok(build_item(&ctx.store, new_id))
    })
    .await?;
    announce_store(emitter, Vec::new());
    Ok(item)
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn custom_duplicate_skill(
    source_id: String,
    new_id: String,
    app: tauri::AppHandle,
) -> Result<CustomSkillItem, CustomSkillsError> {
    custom_duplicate_skill_core(&EventEmitter::from_app(&app), source_id, new_id).await
}

/// Import a skill from disk into the central store. `source_path` may be a
/// directory containing `SKILL.md` (copied whole) or a standalone `.md` file
/// (wrapped as `<id>/SKILL.md`). The id is `id` when given, else derived from
/// the folder/file name. A failed import leaves nothing behind.
pub async fn custom_import_skill_core(
    emitter: &EventEmitter,
    source_path: String,
    id: Option<String>,
) -> Result<CustomSkillItem, CustomSkillsError> {
    let item = under_lock(SkillsCtx::user(), move |ctx| {
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
        let id = ensure_custom_id_in(&ctx.store, derived.as_deref().unwrap_or(""))?;
        if fs::symlink_metadata(ctx.skill_path(&id)).is_ok() {
            return Err(CustomSkillsError::AlreadyExists(id));
        }

        if src.is_dir() {
            if !src.join("SKILL.md").is_file() {
                return Err(CustomSkillsError::InvalidSource(
                    "folder has no SKILL.md".into(),
                ));
            }
            place_skill(ctx, &id, false, |target| {
                copy_tree(&src, target)?;
                drop_ownership_marker(target)
            })?;
        } else if is_markdown(&src) {
            place_skill(ctx, &id, false, |target| {
                copy_markdown_as_skill(&src, target)
            })?;
        } else {
            return Err(CustomSkillsError::InvalidSource(
                "source must be a folder containing SKILL.md, or a .md file".into(),
            ));
        }
        Ok(build_item(&ctx.store, id))
    })
    .await?;
    announce_store(emitter, Vec::new());
    Ok(item)
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn custom_import_skill(
    source_path: String,
    id: Option<String>,
    app: tauri::AppHandle,
) -> Result<CustomSkillItem, CustomSkillsError> {
    custom_import_skill_core(&EventEmitter::from_app(&app), source_path, id).await
}

/// Copy one or more of an agent's **own** (global-scope) skills into the shared
/// central store, so they can be re-enabled for any agent from the matrix. Each
/// id is reported independently (partial success is normal for a
/// multi-select). A skill that is already in the store — e.g. a linked
/// expert/science/office skill, or one imported earlier — is reported as
/// `skipped`, not an error, so re-running is idempotent. (The Harness page
/// moves a skill into Codeg instead: `skills_adopt`.)
pub async fn custom_import_from_agent_core(
    emitter: &EventEmitter,
    agent_type: AgentType,
    ids: Vec<String>,
) -> Result<Vec<CustomImportResult>, CustomSkillsError> {
    custom_import_from_agent_in(SkillsCtx::user(), emitter, agent_type, ids).await
}

/// [`custom_import_from_agent_core`] from the agent directories of `ctx` into
/// its store.
pub(crate) async fn custom_import_from_agent_in(
    ctx: SkillsCtx,
    emitter: &EventEmitter,
    agent_type: AgentType,
    ids: Vec<String>,
) -> Result<Vec<CustomImportResult>, CustomSkillsError> {
    let results = under_lock(ctx, move |ctx| {
        let agent = ctx
            .agent(agent_type)
            .ok_or(CustomSkillsError::UnsupportedAgent(agent_type))?;
        let kind = if agent.markdown_files {
            SkillStorageKind::SkillDirectoryOrMarkdownFile
        } else {
            SkillStorageKind::SkillDirectoryOnly
        };
        let dirs = agent.dirs.clone();
        Ok(ids
            .iter()
            .map(|id| import_one_from_agent_locked(ctx, &dirs, kind, id))
            .collect::<Vec<_>>())
    })
    .await?;
    if results.iter().any(|r| r.ok) {
        announce_store(emitter, Vec::new());
    }
    Ok(results)
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn custom_import_from_agent(
    agent_type: AgentType,
    ids: Vec<String>,
    app: tauri::AppHandle,
) -> Result<Vec<CustomImportResult>, CustomSkillsError> {
    custom_import_from_agent_core(&EventEmitter::from_app(&app), agent_type, ids).await
}

/// Copy one of an agent's global skills into the central store. Never bubbles —
/// returns a per-skill result so the batch keeps going. **Assumes the skills
/// lock is held.**
fn import_one_from_agent_locked(
    ctx: &SkillsCtx,
    global_dirs: &[PathBuf],
    kind: SkillStorageKind,
    raw_id: &str,
) -> CustomImportResult {
    let failed = |id: String, name: String, code: &str, error: String| CustomImportResult {
        id,
        name,
        ok: false,
        skipped: false,
        error: Some(error),
        code: Some(code.to_string()),
    };
    // Resolve the source on disk (a `<id>/` skill dir or a `<id>.md` file) from
    // the agent's GLOBAL skill dirs. Project-scoped skills are workspace-specific
    // and deliberately excluded from the shared store.
    let Some(item) =
        locate_existing_skill_across_dirs(global_dirs, kind, raw_id, AgentSkillScope::Global)
    else {
        return failed(
            raw_id.to_string(),
            raw_id.to_string(),
            codes::NOT_FOUND,
            format!("skill '{raw_id}' not found in the agent's skill directory"),
        );
    };
    let id = item.id.clone();
    let name = item.name.clone();

    // Already in the shared store? Covers a linked expert/science/office skill
    // (its central dir exists) and a previously-imported custom one. Idempotent
    // skip — not an error.
    if fs::symlink_metadata(ctx.skill_path(&id)).is_ok() {
        return CustomImportResult {
            id,
            name,
            ok: false,
            skipped: true,
            error: None,
            code: None,
        };
    }

    // Guard: refuse ids owned by a built-in pack that somehow aren't extracted
    // yet (rare — built-ins are normally present, so this path is a safety net).
    if let Err(err) = ensure_custom_id_in(&ctx.store, &id) {
        let code = err.code();
        return failed(id, name, code, err.to_string());
    }

    let src = PathBuf::from(&item.path);
    // Staged in full and renamed into place: a copy that fails leaves nothing.
    let copied = place_skill(ctx, &id, false, |target| match item.layout {
        AgentSkillLayout::SkillDirectory => {
            copy_tree(&src, target)?;
            drop_ownership_marker(target)
        }
        AgentSkillLayout::MarkdownFile => copy_markdown_as_skill(&src, target),
    });
    match copied {
        Ok(_) => CustomImportResult {
            id,
            name,
            ok: true,
            skipped: false,
            error: None,
            code: None,
        },
        Err(err) => failed(id, name, codes::IO_ERROR, err.to_string()),
    }
}

/// Batch-delete custom skills. For each id: first unlink from **every** agent
/// (Codeg's links, and its copies that nobody changed — foreign links and real
/// folders are left in place), then remove the central directory. Per-skill
/// failures are reported, not fatal. Only a Custom skill — by whose it is,
/// not by its id — is deleted.
pub async fn custom_delete_skills_core(
    emitter: &EventEmitter,
    ids: Vec<String>,
) -> Result<Vec<CustomDeleteResult>, CustomSkillsError> {
    custom_delete_skills_in(SkillsCtx::user(), emitter, ids).await
}

/// [`custom_delete_skills_core`] in the store and agents of `ctx`.
pub(crate) async fn custom_delete_skills_in(
    ctx: SkillsCtx,
    emitter: &EventEmitter,
    ids: Vec<String>,
) -> Result<Vec<CustomDeleteResult>, CustomSkillsError> {
    let (results, agents) = under_lock(ctx, move |ctx| {
        let mut out = Vec::with_capacity(ids.len());
        let mut agents = Vec::new();
        for id in ids {
            out.push(match delete_one_locked(ctx, &id) {
                Ok(touched) => {
                    agents.extend(touched);
                    CustomDeleteResult {
                        id,
                        ok: true,
                        error: None,
                        code: None,
                    }
                }
                Err(err) => CustomDeleteResult {
                    id,
                    ok: false,
                    code: Some(err.code().to_string()),
                    error: Some(err.to_string()),
                },
            });
        }
        Ok((out, agents))
    })
    .await?;
    if results.iter().any(|r| r.ok) {
        crate::skills::announce(emitter, [ChangedKind::Store, ChangedKind::Links], agents);
    }
    Ok(results)
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn custom_delete_skills(
    ids: Vec<String>,
    app: tauri::AppHandle,
) -> Result<Vec<CustomDeleteResult>, CustomSkillsError> {
    custom_delete_skills_core(&EventEmitter::from_app(&app), ids).await
}

fn delete_one_locked(ctx: &SkillsCtx, id: &str) -> Result<Vec<AgentType>, CustomSkillsError> {
    let id = ensure_custom_skill_in(&ctx.store, id)?;
    // 1) Detach from every agent. A foreign link or a folder at the same path
    // isn't ours: it stays, and does not stop the delete.
    let (agents, problems) = crate::skills::packs::unlink_everywhere(ctx, &id);
    let fatal: Vec<String> = problems
        .iter()
        .filter(|p| p.code != codes::COPY_MODIFIED_KEPT)
        .map(|p| {
            format!(
                "{} {}: {}",
                p.code,
                p.path.clone().unwrap_or_default(),
                p.detail.clone().unwrap_or_default()
            )
        })
        .collect();
    if !fatal.is_empty() {
        return Err(CustomSkillsError::Io(fatal.join("; ")));
    }
    // 2) Remove the central directory (through staging; a link is only
    // detached).
    crate::skills::packs::remove_from_store(ctx, &id)?;
    Ok(agents)
}

// ─── Filesystem helpers ─────────────────────────────────────────────────

/// A new Custom skill is nobody else's: the UI pack's mark on a folder it
/// was copied from (`.codeg-managed`) goes, so the copy can never read as
/// Codeg's (under `ui-render` or `json-render`, a marked folder is the UI
/// pack's, and its 0.35.0 clean-up removes `json-render`).
fn drop_ownership_marker(target: &Path) -> io::Result<()> {
    let marker = target.join(crate::skills::provenance::UI_MARKER);
    match fs::remove_file(&marker) {
        Err(err) if err.kind() != io::ErrorKind::NotFound => Err(err),
        _ => Ok(()),
    }
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
        .unwrap_or(false)
}

// ─── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)] // only the unix-only link tests below
    use crate::commands::experts::{path_is_symlink, ExpertLinkState};
    use tokio::time::{timeout, Duration};

    // Every test here works in a store (and agent directories) of its own:
    // an injected `SkillsCtx` (`skills::tests::fixture_ctx`), or, for the few
    // unix-only ones below, a temporary `HOME`. The real home's skills and
    // agent directories are never read or written.

    /// A store and agents of the test's own.
    fn fixture() -> (tempfile::TempDir, SkillsCtx) {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ctx = crate::skills::tests::fixture_ctx(&root);
        (tmp, ctx)
    }

    #[test]
    fn reserved_ids_include_known_bundled() {
        let (_tmp, ctx) = fixture();
        assert!(
            matches!(
                ensure_custom_id_in(&ctx.store, "brainstorming"),
                Err(CustomSkillsError::ReservedId(_))
            ),
            "experts id missing"
        );
        assert!(!crate::commands::experts::bundled_ids().is_empty());
    }

    #[test]
    fn ensure_custom_id_rejects_reserved() {
        let (_tmp, ctx) = fixture();
        let err = ensure_custom_id_in(&ctx.store, "brainstorming").unwrap_err();
        assert!(matches!(err, CustomSkillsError::ReservedId(_)), "{err:?}");
    }

    #[test]
    fn ensure_custom_id_accepts_free_id() {
        let (_tmp, ctx) = fixture();
        assert_eq!(
            ensure_custom_id_in(&ctx.store, "  my-custom-skill  ").unwrap(),
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
        // Custom agents come from the process-wide registry, which other tests
        // hydrate in parallel: hold it still between the two reads.
        let _guard = crate::acp::custom_registry::hydrate_test_guard();
        let agents = supported_agents();
        assert!(!agents.is_empty());
        assert!(agents.iter().all(|a| skill_storage_spec(*a).is_some()));
    }

    /// ZCode's runtime loads user skills from `<os home>/.zcode/skills` whatever
    /// `ZCODE_HOME` says, so a matrix link must land there and not follow it.
    /// Its home is the one Node reads, `HOME` or on Windows `USERPROFILE`;
    /// both are pinned so the link lands in the fixture on every platform.
    #[test]
    fn zcode_joins_the_custom_skill_matrix_at_its_os_home_store() {
        let tmp = tempfile::tempdir().unwrap();
        let (home, relocated) = (tmp.path().join("home"), tmp.path().join("relocated"));
        temp_env::with_vars(
            [
                ("HOME", Some(&home)),
                ("USERPROFILE", Some(&home)),
                ("ZCODE_HOME", Some(&relocated)),
            ],
            || {
                assert!(supported_agents().contains(&AgentType::ZCode));
                assert_eq!(
                    agent_link_path(AgentType::ZCode, "example").unwrap(),
                    home.join(".zcode").join("skills").join("example")
                );
            },
        );
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
        let (_tmp, ctx) = fixture();
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
        let results = timeout(
            Duration::from_secs(5),
            custom_apply_links_in(ctx, &EventEmitter::Noop, ops),
        )
        .await
        .expect("custom_apply_links must not deadlock")
        .expect("batch returns Ok");
        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|r| r.ok), "{results:?}");
    }

    #[tokio::test]
    async fn apply_links_collects_per_op_results_without_aborting() {
        let (_tmp, ctx) = fixture();
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
        let results = custom_apply_links_in(ctx, &EventEmitter::Noop, ops)
            .await
            .expect("batch returns Ok");
        assert_eq!(results.len(), 2);
        assert!(results[0].ok, "idempotent disable should succeed");
        assert!(
            !results[1].ok,
            "enable of missing central skill should fail"
        );
        assert!(results[1].error.is_some());
        assert!(results[1].status.is_none());
    }

    #[tokio::test]
    async fn delete_absent_skills_report_per_id() {
        // Deleting ids with no central dir + no links is an idempotent success.
        let (_tmp, ctx) = fixture();
        let results = custom_delete_skills_in(
            ctx,
            &EventEmitter::Noop,
            vec![
                "zzz-codeg-custom-delete-absent-1".into(),
                "zzz-codeg-custom-delete-absent-2".into(),
            ],
        )
        .await
        .expect("batch returns Ok");
        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|r| r.ok), "{results:?}");
    }

    #[tokio::test]
    async fn create_and_save_reject_reserved_ids() {
        let (_tmp, ctx) = fixture();
        let created = custom_create_skill_in(
            ctx.clone(),
            &EventEmitter::Noop,
            "writing-plans".into(),
            "x".into(),
        )
        .await;
        let saved =
            custom_save_skill_in(ctx, &EventEmitter::Noop, "writing-plans".into(), "x".into())
                .await;
        assert!(matches!(created, Err(CustomSkillsError::ReservedId(_))));
        assert!(matches!(saved, Err(CustomSkillsError::ReservedId(_))));
    }

    #[tokio::test]
    async fn import_from_agent_reports_missing_ids_without_mutating() {
        // Ids that don't exist in the agent's skill dir → each op fails to
        // locate a source and is reported.
        let (_tmp, ctx) = fixture();
        let store = ctx.store.clone();
        let results = custom_import_from_agent_in(
            ctx,
            &EventEmitter::Noop,
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
            results
                .iter()
                .all(|r| !r.ok && !r.skipped && r.error.is_some()),
            "{results:?}"
        );
        assert!(collect_custom_ids(&store).unwrap().is_empty());
    }

    #[tokio::test]
    async fn list_all_install_statuses_is_wellformed() {
        // A row per custom skill and skill-capable agent of the store and
        // agents of the test's own, holding two custom skills.
        let (_tmp, ctx) = fixture();
        for id in ["wellformed-a", "wellformed-b"] {
            custom_create_skill_in(
                ctx.clone(),
                &EventEmitter::Noop,
                id.into(),
                format!("---\nname: {id}\n---\n"),
            )
            .await
            .expect("create");
        }
        let rows = custom_list_all_install_statuses_in(ctx.clone())
            .await
            .expect("snapshot returns Ok");
        let ids = collect_custom_ids(&ctx.store).expect("ids");
        let agents: Vec<AgentType> = ctx.agents.iter().map(|a| a.agent).collect();
        assert_eq!(ids.len(), 2);
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

    /// A Custom command changes or deletes an existing skill by whose it is,
    /// not by its id: a skill of the user's whose id a pack later bundled
    /// (the pack's is "name taken") stays theirs to edit and delete, and a
    /// skill the Harness manifest claims is not, whatever its id.
    #[tokio::test]
    async fn editing_and_deleting_follow_whose_the_skill_is_not_its_name() {
        let (_tmp, ctx) = fixture();
        let store = ctx.store.clone();
        let write = |id: &str, body: &str| {
            fs::create_dir_all(store.join(id)).unwrap();
            fs::write(store.join(id).join("SKILL.md"), body).unwrap();
        };
        // `brainstorming` is an Experts id; the Experts manifest does not
        // list it (the pack found the user's skill there: name taken).
        write("brainstorming", "---\nname: brainstorming\n---\nmine\n");
        fs::write(
            store.join(".manifest.json"),
            r#"{"codeg_version":"x","installed_at":"x","experts":{}}"#,
        )
        .unwrap();
        // A Harness skill under an id no pack bundles.
        write("h-skill", "---\nname: h-skill\n---\nfrom harness\n");
        fs::write(
            store.join(".manifest.harness.json"),
            r#"{"skills":{"h-skill":{"item_id":"i","ref":"srn:x","revision":1,"version":"1"}}}"#,
        )
        .unwrap();

        let saved = custom_save_skill_in(
            ctx.clone(),
            &EventEmitter::Noop,
            "brainstorming".into(),
            "edited\n".into(),
        )
        .await;
        assert!(saved.is_ok(), "{saved:?}");
        assert_eq!(
            fs::read_to_string(store.join("brainstorming/SKILL.md")).unwrap(),
            "edited\n"
        );

        let refused = custom_save_skill_in(
            ctx.clone(),
            &EventEmitter::Noop,
            "h-skill".into(),
            "overwritten\n".into(),
        )
        .await;
        let err = refused.expect_err("a Harness skill is not a custom one");
        assert_eq!(err.code(), codes::ID_RESERVED);
        let app = AppCommandError::from(&err);
        assert_eq!(
            app.i18n_params
                .unwrap_or_default()
                .get("detail")
                .map(String::as_str),
            Some("harness")
        );
        assert_eq!(
            fs::read_to_string(store.join("h-skill/SKILL.md")).unwrap(),
            "---\nname: h-skill\n---\nfrom harness\n"
        );

        let deleted = custom_delete_skills_in(
            ctx.clone(),
            &EventEmitter::Noop,
            vec!["h-skill".into(), "brainstorming".into()],
        )
        .await
        .unwrap();
        assert!(!deleted[0].ok, "{deleted:?}");
        assert_eq!(deleted[0].code.as_deref(), Some(codes::ID_RESERVED));
        assert!(store.join("h-skill/SKILL.md").is_file(), "left alone");
        assert!(deleted[1].ok, "{deleted:?}");
        assert!(!store.join("brainstorming").exists(), "the user's own goes");

        // A pack's own skill (listed in its manifest) is still refused.
        write("writing-plans", "the pack's\n");
        fs::write(
            store.join(".manifest.json"),
            r#"{"codeg_version":"x","installed_at":"x","experts":{"writing-plans":{"hash":"h","installed_at":"x"}}}"#,
        )
        .unwrap();
        let pack = custom_save_skill_in(
            ctx.clone(),
            &EventEmitter::Noop,
            "writing-plans".into(),
            "x".into(),
        )
        .await;
        assert!(
            matches!(pack, Err(CustomSkillsError::ReservedId(_))),
            "{pack:?}"
        );
        assert_eq!(
            fs::read_to_string(store.join("writing-plans/SKILL.md")).unwrap(),
            "the pack's\n"
        );
    }

    /// "Copy as custom" (follow-up C3): any skill in the store — a pack's,
    /// a Harness one, the UI pack's — can be the source; the copy is a Custom
    /// skill under the new, free id, carrying no claim of the source's (the
    /// UI pack's marker stays behind, so even under `json-render` the copy is
    /// the user's).
    #[tokio::test]
    async fn copy_as_custom_takes_any_skill_and_makes_it_the_users() {
        use crate::skills::provenance::{Provenance, UI_MARKER};
        let (_tmp, ctx) = fixture();
        let store = ctx.store.clone();
        let write = |id: &str, body: &str| {
            fs::create_dir_all(store.join(id)).unwrap();
            fs::write(store.join(id).join("SKILL.md"), body).unwrap();
        };
        write("writing-plans", "the pack's\n");
        fs::write(
            store.join(".manifest.json"),
            r#"{"codeg_version":"x","installed_at":"x","experts":{"writing-plans":{"hash":"h","installed_at":"x"}}}"#,
        )
        .unwrap();
        write("h-skill", "from harness\n");
        fs::write(
            store.join(".manifest.harness.json"),
            r#"{"skills":{"h-skill":{"item_id":"i","ref":"srn:x","revision":1,"version":"1"}}}"#,
        )
        .unwrap();
        write("ui-render", "the UI pack's\n");
        fs::write(
            store.join("ui-render").join(UI_MARKER),
            "Codeg installs this\n",
        )
        .unwrap();

        for (source, copy) in [
            ("writing-plans", "my-plans"),
            ("h-skill", "my-h"),
            ("ui-render", "json-render"),
        ] {
            let item = custom_duplicate_skill_in(
                ctx.clone(),
                &EventEmitter::Noop,
                source.into(),
                copy.into(),
            )
            .await
            .unwrap_or_else(|e| panic!("{source}: {e}"));
            assert_eq!(item.id, copy);
            assert_eq!(
                fs::read(store.join(copy).join("SKILL.md")).unwrap(),
                fs::read(store.join(source).join("SKILL.md")).unwrap()
            );
            assert!(!store.join(copy).join(UI_MARKER).exists(), "{copy}");
            assert_eq!(
                Provenance::load(&store).origin_of(&store, copy),
                Some(SkillOrigin::Custom),
                "{copy}"
            );
        }
        // The sources are as they were, and a pack's id is still not free.
        assert!(store.join("ui-render").join(UI_MARKER).is_file());
        let taken = custom_duplicate_skill_in(
            ctx.clone(),
            &EventEmitter::Noop,
            "h-skill".into(),
            "brainstorming".into(),
        )
        .await;
        assert!(
            matches!(taken, Err(CustomSkillsError::ReservedId(_))),
            "{taken:?}"
        );
    }

    #[test]
    fn validate_skill_id_rejects_traversal_and_separators() {
        // The load-bearing sanitizer every authoring path funnels through.
        for bad in [
            "", "  ", "..", "../x", "a/b", "a\\b", ".hidden", "a:b", "a b",
        ] {
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
            custom_create_skill_core(&EventEmitter::Noop, id.into(), content.into())
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
            custom_save_skill_core(&EventEmitter::Noop, id.into(), updated.into())
                .await
                .expect("save");
            assert_eq!(fs::read_to_string(&md).unwrap(), updated);

            let dir = central_experts_dir().join(id);
            let results = custom_delete_skills_core(&EventEmitter::Noop, vec![id.into()])
                .await
                .expect("delete batch");
            assert!(results.iter().all(|r| r.ok), "{results:?}");
            assert!(!dir.exists(), "central dir must be gone after delete");
        })
        .await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fs_zcode_import_and_matrix_links_use_its_os_home_store() {
        let tmp = tempfile::tempdir().unwrap();
        // The runtime's user store; a relocated `ZCODE_HOME` must not move it.
        let native = tmp.path().join(".zcode");
        let relocated = tmp.path().join("relocated");
        temp_env::async_with_vars(
            [
                ("HOME", Some(tmp.path())),
                ("ZCODE_HOME", Some(relocated.as_path())),
            ],
            async {
                assert!(central_experts_dir().starts_with(tmp.path()));
                let source = native.join("skills/zcode-import-fixture");
                fs::create_dir_all(source.join("references")).unwrap();
                fs::write(
                    source.join("SKILL.md"),
                    "---\nname: Original\ndescription: Example\n---\nbody",
                )
                .unwrap();
                fs::write(source.join("references/proof.txt"), "asset").unwrap();
                let imported = custom_import_from_agent_core(
                    &EventEmitter::Noop,
                    AgentType::ZCode,
                    vec!["zcode-import-fixture".into()],
                )
                .await
                .unwrap();
                assert!(imported[0].ok, "{imported:?}");
                assert_eq!(
                    fs::read_to_string(
                        central_experts_dir().join("zcode-import-fixture/references/proof.txt")
                    )
                    .unwrap(),
                    "asset"
                );

                let id = "zcode-managed-fixture";
                custom_create_skill_core(
                    &EventEmitter::Noop,
                    id.into(),
                    "---\nname: Managed\ndescription: Test\n---\nbody".into(),
                )
                .await
                .unwrap();
                let rows = custom_apply_links_core(
                    &EventEmitter::Noop,
                    vec![LinkOp {
                        expert_id: id.into(),
                        agent_type: AgentType::ZCode,
                        enable: true,
                    }],
                )
                .await
                .unwrap();
                assert!(rows[0].ok, "{rows:?}");
                assert_eq!(
                    rows[0].status.as_ref().unwrap().state,
                    ExpertLinkState::LinkedToCodeg
                );
                let link = native.join("skills").join(id);
                assert!(path_is_symlink(&link));
                let rows = custom_list_all_install_statuses().await.unwrap();
                assert!(rows.iter().any(|r| r.expert_id == id
                    && r.agent_type == AgentType::ZCode
                    && r.state == ExpertLinkState::LinkedToCodeg));
                let rows = custom_apply_links_core(
                    &EventEmitter::Noop,
                    vec![LinkOp {
                        expert_id: id.into(),
                        agent_type: AgentType::ZCode,
                        enable: false,
                    }],
                )
                .await
                .unwrap();
                assert!(rows[0].ok, "{rows:?}");
                assert!(!link.exists() && !path_is_symlink(&link));
                assert!(central_experts_dir().join(id).join("SKILL.md").is_file());
                assert!(source.join("references/proof.txt").is_file());
                assert!(!relocated.exists(), "nothing is written under ZCODE_HOME");
            },
        )
        .await;
    }

    /// The generative-UI skill shares the central store but is only Codeg's
    /// once its marker is there; until then a `ui-render` is the user's.
    #[cfg(unix)]
    #[tokio::test]
    async fn fs_ui_render_stays_custom_until_codeg_marks_it() {
        with_temp_home(|| async {
            let id = crate::commands::generative_ui::SKILL_ID;
            let content = "---\nname: ui-render\n---\nmine\n";
            custom_create_skill_core(&EventEmitter::Noop, id.into(), content.into())
                .await
                .expect("free until Codeg claims it");
            let listed = |items: Vec<CustomSkillItem>| items.iter().any(|s| s.id == id);
            assert!(listed(custom_list().await.expect("list")));

            fs::write(
                central_experts_dir()
                    .join(id)
                    .join(crate::commands::generative_ui::MARKER_FILE),
                "",
            )
            .unwrap();
            assert!(!listed(custom_list().await.expect("list")));
            assert!(matches!(
                custom_save_skill_core(&EventEmitter::Noop, id.into(), content.into()).await,
                Err(CustomSkillsError::ReservedId(_))
            ));
        })
        .await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fs_delete_unlinks_agent_before_removing_central() {
        with_temp_home(|| async {
            let id = "my-linked-skill";
            custom_create_skill_core(
                &EventEmitter::Noop,
                id.into(),
                "---\nname: L\n---\nx\n".into(),
            )
            .await
            .expect("create");

            let res = custom_apply_links_core(
                &EventEmitter::Noop,
                vec![LinkOp {
                    expert_id: id.into(),
                    agent_type: AgentType::ClaudeCode,
                    enable: true,
                }],
            )
            .await
            .expect("apply batch");
            assert!(res[0].ok, "link enable should succeed: {res:?}");

            let link = agent_link_path(AgentType::ClaudeCode, id).expect("link path");
            assert!(
                path_is_symlink(&link),
                "agent link should exist after enable"
            );

            let dir = central_experts_dir().join(id);
            let del = custom_delete_skills_core(&EventEmitter::Noop, vec![id.into()])
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
            custom_create_skill_core(
                &EventEmitter::Noop,
                "orig-skill".into(),
                "---\nname: O\n---\nbody\n".into(),
            )
            .await
            .expect("create orig");
            custom_duplicate_skill_core(
                &EventEmitter::Noop,
                "orig-skill".into(),
                "copy-skill".into(),
            )
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
            custom_import_skill_core(
                &EventEmitter::Noop,
                src_md.to_string_lossy().into_owned(),
                None,
            )
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
            custom_import_skill_core(
                &EventEmitter::Noop,
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
                    custom_create_skill_core(&EventEmitter::Noop, bad.into(), "x".into())
                        .await
                        .is_err(),
                    "create must reject {bad:?}"
                );
                assert!(
                    custom_save_skill_core(&EventEmitter::Noop, bad.into(), "x".into())
                        .await
                        .is_err(),
                    "save must reject {bad:?}"
                );
            }

            // Batch delete reports each bad id as a validation failure (never a
            // successful escape).
            let del = custom_delete_skills_core(
                &EventEmitter::Noop,
                ["../SENTINEL", "..", "/etc/passwd"]
                    .iter()
                    .map(|s| s.to_string())
                    .collect(),
            )
            .await
            .expect("batch returns Ok");
            assert!(del.iter().all(|r| !r.ok && r.error.is_some()), "{del:?}");

            assert!(
                sentinel.is_file(),
                "sentinel outside the store must survive"
            );
            assert_eq!(fs::read_to_string(&sentinel).unwrap(), "keep me");
        })
        .await;
    }
}
