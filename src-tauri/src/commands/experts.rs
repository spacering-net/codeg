//! Built-in expert skills management.
//!
//! Experts are curated skills (from obra/superpowers) that codeg bundles
//! into its binary via `include_dir!`. On startup they are extracted to a
//! central directory `~/.codeg/skills/<id>/`. Users can then enable an
//! expert for any ACP agent by creating a symbolic link (or Windows
//! junction) from the agent's skill directory into the central copy.
//!
//! The central store is the single source of truth. Enabling/disabling is
//! purely "does a link exist in the agent's skill dirs" — there is no
//! database state, and updates propagate automatically when codeg upgrades
//! and re-extracts the bundled files. Extraction, linking and status all go
//! through the skills engine (`crate::skills`): this module holds the bundle,
//! its metadata, and the commands the Experts tab calls, which are thin
//! wrappers over the engine (`skills::legacy`).
//!
//! `experts/skills/` is vendored from Superpowers v7.0.2 (see
//! `experts/NOTICE.md` for the pinned source and license) with two
//! standalone-runtime adaptations. `writing-skills/package.json` carries the
//! root `"type": "module"` marker that `render-graphs.js` needs after skill
//! extraction, and `executing-plans/scripts/` carries local copies of the
//! shared workspace helpers. The latter prevents a foreign sibling skill from
//! shadowing the intended helper and keeps the plan workflow usable when
//! Windows has to copy just one skill instead of creating a junction. Keep the
//! upstream tree in sync with `rsync --delete` plus a `diff -rq` check, then
//! re-apply these documented adaptations. Adaptation files stay in the bundle
//! rather than being written at extraction time: the extraction compares the
//! on-disk hash against the bundled one, so generated files would look
//! user-modified and get backed up on every launch.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use include_dir::{include_dir, Dir};
use serde::{Deserialize, Serialize};

use crate::app_error::AppCommandError;
use crate::commands::acp::{skill_storage_spec, validate_skill_id};
use crate::models::agent::AgentType;
use crate::skills::model::SkillOrigin;
use crate::skills::packs::{self, Bundle};
use crate::skills::{legacy, SkillsCtx};
use crate::web::event_bridge::EventEmitter;

pub use crate::skills::packs::InstallReport;

// ─── Embedded bundle ────────────────────────────────────────────────────

static EXPERTS_BUNDLE: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/experts");

const CENTRAL_DIR_NAME: &str = ".codeg";
const CENTRAL_SKILLS_SUBDIR: &str = "skills";
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

impl ExpertsError {
    pub fn code(&self) -> &'static str {
        use crate::skills::model::codes;
        match self {
            ExpertsError::NotFound(_) | ExpertsError::CentralUnavailable(_) => {
                codes::SKILL_NOT_FOUND
            }
            ExpertsError::UnsupportedAgent(_) => codes::AGENT_UNSUPPORTED,
            ExpertsError::NameCollision { .. } => codes::TARGET_OCCUPIED,
            ExpertsError::ForeignLink { .. } => codes::TARGET_LINKED_ELSEWHERE,
            ExpertsError::Io(_) => codes::IO_ERROR,
            ExpertsError::Metadata(_) => codes::SKILL_INVALID,
        }
    }
}

impl From<&ExpertsError> for AppCommandError {
    fn from(error: &ExpertsError) -> Self {
        crate::skills::coded_error(
            AppCommandError::task_execution_failed(error.to_string()),
            error.code(),
            None,
        )
    }
}

/// On both transports an error is an `AppCommandError` with its stable code.
impl Serialize for ExpertsError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        AppCommandError::from(self).serialize(serializer)
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
    /// The store holds a skill of another origin under this id (a Custom
    /// skill of the user's): the expert is not installed, and not linked.
    pub name_taken: bool,
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
    /// The failure's stable code (`crate::skills::model::codes`); `None` on
    /// success.
    pub code: Option<String>,
}

// ─── Paths ──────────────────────────────────────────────────────────────

fn home_dir_or_default() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// Codeg's skill store, `~/.codeg/skills` under the real home (it does not
/// follow `CODEG_HOME` / `CODEG_DATA_DIR`).
pub(crate) fn central_experts_dir() -> PathBuf {
    home_dir_or_default()
        .join(CENTRAL_DIR_NAME)
        .join(CENTRAL_SKILLS_SUBDIR)
}

fn expert_central_path(expert_id: &str) -> PathBuf {
    central_experts_dir().join(expert_id)
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

/// Ids of all bundled experts. Used by the custom-skills pack to keep
/// built-in ids out of new custom skills, and by the engine's "name taken".
pub(crate) fn bundled_ids() -> Vec<String> {
    bundled_metadata().iter().map(|m| m.id.clone()).collect()
}

fn find_metadata(expert_id: &str) -> Result<&'static ExpertMetadata, ExpertsError> {
    bundled_metadata()
        .iter()
        .find(|m| m.id == expert_id)
        .ok_or_else(|| ExpertsError::NotFound(expert_id.to_string()))
}

// ─── Hashing and extraction (the engine's, over this bundle) ────────────

fn hash_bundled_expert(expert_id: &str) -> Result<String, ExpertsError> {
    packs::bundled_hash(&EXPERTS_BUNDLE, expert_id)
        .ok_or_else(|| ExpertsError::NotFound(expert_id.to_string()))
}

#[cfg(test)]
fn collect_bundle_files<'a>(dir: &'a Dir<'a>, out: &mut Vec<(&'a str, &'a [u8])>) {
    packs::bundle_files(dir, out)
}

/// The hash of a skill folder, as the manifest records it — leaving out what
/// using a skill leaves behind (`__pycache__/`, `*.pyc`, `.DS_Store`,
/// `Thumbs.db`).
#[cfg(test)]
fn hash_disk_directory(path: &Path) -> Result<String, ExpertsError> {
    let id = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string();
    Ok(crate::skills::fsio::hash_skill_dir(path, &id)?)
}

#[cfg(test)]
fn extract_expert_to_disk(meta: &ExpertMetadata, target: &Path) -> Result<(), ExpertsError> {
    Ok(packs::extract_bundle_skill(&EXPERTS_BUNDLE, &meta.id, target)?)
}

// ─── Link primitives (kept for the modules and tests that plant links) ──

/// A directory link at `dst` to `src`, the platform's way (symlink /
/// junction). Never a copy: the engine decides when a copy may stand in.
/// Returns `false` ("not a copy"), as it always has.
pub(crate) fn create_link_raw(src: &Path, dst: &Path) -> io::Result<bool> {
    crate::skills::link::platform_link(src, dst).map(|_| false)
}

#[cfg(all(test, unix))]
pub(crate) fn path_is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

/// Whether `link_path` is a link that resolves to `expected_target`, another
/// link, a real folder, a broken link, or nothing.
pub(crate) fn classify_link(link_path: &Path, expected_target: &Path) -> ExpertLinkState {
    use crate::skills::link::{inspect, RawEntry};
    match inspect(link_path) {
        RawEntry::Absent | RawEntry::Unreadable(_) => ExpertLinkState::NotLinked,
        RawEntry::Dir | RawEntry::File => ExpertLinkState::BlockedByRealDirectory,
        RawEntry::Link { resolved, .. } => match (resolved, fs::canonicalize(expected_target).ok()) {
            (None, _) => ExpertLinkState::Broken,
            (Some(l), Some(e)) if crate::skills::fsio::same_path(&l, &e) => {
                ExpertLinkState::LinkedToCodeg
            }
            _ => ExpertLinkState::LinkedElsewhere,
        },
    }
}

// ─── Central store installation ────────────────────────────────────────

fn bundle() -> Bundle<'static> {
    Bundle {
        origin: SkillOrigin::Experts,
        dir: &EXPERTS_BUNDLE,
        skills: bundled_metadata()
            .iter()
            .map(|m| (m.id.clone(), m.bundled_hash.clone()))
            .collect(),
    }
}

/// Extract or update the bundled experts in `ctx`'s store, under the skills
/// lock. Blocking.
pub(crate) fn install_in(ctx: &SkillsCtx) -> InstallReport {
    match ctx.lock_blocking() {
        Ok(_guard) => packs::install_bundle(ctx, &bundle()),
        Err(err) => InstallReport {
            errors: vec![format!("skills lock: {err}")],
            ..InstallReport::default()
        },
    }
}

pub async fn ensure_central_experts_installed() -> InstallReport {
    tokio::task::spawn_blocking(|| install_in(&SkillsCtx::user()))
        .await
        .unwrap_or_else(|e| InstallReport {
            errors: vec![format!("join error: {e}")],
            ..InstallReport::default()
        })
}

// ─── Commands: list / status ────────────────────────────────────────────

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn experts_list() -> Result<Vec<ExpertListItem>, ExpertsError> {
    let store = central_experts_dir();
    let provenance = crate::skills::provenance::Provenance::load(&store);
    let mut out = Vec::new();
    for meta in bundled_metadata().iter().cloned() {
        let central_path = expert_central_path(&meta.id);
        let present = central_path.exists();
        let ours = provenance.origin_of(&store, &meta.id) == Some(SkillOrigin::Experts);
        out.push(ExpertListItem {
            installed_centrally: present && ours,
            user_modified: ours && provenance.pending_user_review(&meta.id),
            name_taken: present && !ours,
            central_path: central_path.to_string_lossy().to_string(),
            metadata: meta,
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
        AgentType::Kiro,
        AgentType::ZCode,
        AgentType::Trae,
        AgentType::CommandCode,
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

/// One-shot snapshot of every (expert, agent) link state — lets the matrix UI
/// render the whole grid from a single round-trip. A cell is
/// `linked_to_codeg` when the agent sees the expert through any directory it
/// reads.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn experts_list_all_install_statuses() -> Result<Vec<ExpertInstallStatus>, ExpertsError> {
    let ids = bundled_ids();
    let agents = supported_agents();
    tokio::task::spawn_blocking(move || {
        legacy::statuses(&SkillsCtx::user(), SkillOrigin::Experts, &ids, &agents)
    })
    .await
    .map_err(|e| ExpertsError::Io(format!("join error: {e}")))
}

// ─── Commands: link / unlink ────────────────────────────────────────────

/// Apply a batch of enable/disable operations under the skills lock.
///
/// Each op is applied independently: a failing op records `ok: false` with
/// its error and code, and the batch continues. One that would change what
/// another agent sees (a link in a shared directory) fails with
/// `acknowledgement_required`: that is done on the Harness page, which asks
/// first (`skills_apply_links`).
pub async fn experts_apply_links_core(
    emitter: &EventEmitter,
    ops: Vec<LinkOp>,
) -> Result<Vec<LinkOpResult>, ExpertsError> {
    apply_links_in(SkillsCtx::user(), emitter, ops).await
}

async fn apply_links_in(
    ctx: SkillsCtx,
    emitter: &EventEmitter,
    ops: Vec<LinkOp>,
) -> Result<Vec<LinkOpResult>, ExpertsError> {
    let guard = match ctx.lock().await {
        Ok(guard) => guard,
        Err(err) => return Ok(legacy::busy(&ops, &err)),
    };
    let task_ctx = ctx.clone();
    let (results, changed) = tokio::task::spawn_blocking(move || {
        let _guard = guard;
        // As before: enabling needs an expert of the bundle; disabling an id
        // that is not one is an idempotent success.
        legacy::apply_ops(&task_ctx, SkillOrigin::Experts, &ops, |id, enable| {
            (enable && find_metadata(id).is_err())
                .then(|| ExpertsError::NotFound(id.to_string()).to_string())
        })
    })
    .await
    .map_err(|e| ExpertsError::Io(format!("join error: {e}")))?;
    if !changed.dirs.is_empty() {
        crate::skills::announce(
            emitter,
            [crate::skills::model::ChangedKind::Links],
            changed.agents(&ctx),
        );
    }
    Ok(results)
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn experts_apply_links(
    ops: Vec<LinkOp>,
    app: tauri::AppHandle,
) -> Result<Vec<LinkOpResult>, ExpertsError> {
    experts_apply_links_core(&EventEmitter::from_app(&app), ops).await
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
    fn bundled_catalog_covers_all_skills_and_fits_compaction_limit() {
        let metadata = load_bundled_metadata_inner().expect("valid expert metadata");
        let skills = EXPERTS_BUNDLE.get_dir("skills").expect("bundled skills");
        assert_eq!(metadata.len(), skills.dirs().count());
        let ids: std::collections::BTreeSet<_> = metadata.iter().map(|m| &m.id).collect();
        assert_eq!(ids.len(), metadata.len(), "expert ids must be unique");

        for meta in &metadata {
            let path = format!("skills/{}/SKILL.md", meta.id);
            let skill = EXPERTS_BUNDLE.get_file(&path).expect("expert SKILL.md");
            // Claude Code reattaches skills after compaction with a 20,000
            // character cut. Bytes are the stricter limit for non-ASCII text.
            assert!(
                skill.contents().len() < 20_000,
                "{} is {} bytes; move supporting content into references/",
                meta.id,
                skill.contents().len()
            );
        }
    }

    #[test]
    fn extracted_experts_preserve_nested_resources_hashes_and_executables() {
        let root = tempfile::tempdir().expect("isolated central store");
        for meta in load_bundled_metadata_inner().expect("valid expert metadata") {
            let target = root.path().join(&meta.id);
            extract_expert_to_disk(&meta, &target).expect("extract complete skill");
            assert_eq!(
                hash_disk_directory(&target).expect("hash extracted skill"),
                meta.bundled_hash,
                "{} must stay pristine after extraction",
                meta.id
            );

            let prefix = format!("skills/{}/", meta.id);
            let dir = EXPERTS_BUNDLE
                .get_dir(prefix.trim_end_matches('/'))
                .expect("bundled skill");
            let mut files = Vec::new();
            collect_bundle_files(dir, &mut files);
            for (path, contents) in files {
                let extracted = target.join(path.strip_prefix(&prefix).expect("skill path"));
                assert_eq!(fs::read(&extracted).expect("extracted resource"), contents);
                #[cfg(unix)]
                if contents.starts_with(b"#!") {
                    use std::os::unix::fs::PermissionsExt;
                    assert_eq!(
                        fs::metadata(&extracted).unwrap().permissions().mode() & 0o111,
                        0o111,
                        "{path} must be executable after extraction"
                    );
                }
            }
        }
    }

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

    #[cfg(not(windows))] // only the hermetic-home tests below
    use tokio::time::{timeout, Duration};

    // These tests run against a home of their own (`with_hermetic_home`):
    // the real home's skills and agent directories are never read or
    // written. They use ids that are well-formed but absent from the bundle.

    #[cfg(not(windows))] // a home of its own: `skills::tests::with_hermetic_home`
    #[tokio::test]
    async fn apply_links_does_not_deadlock() {
        // The keystone regression: `experts_apply_links` takes the
        // (non-reentrant) skills lock once and must call the lock-free inner
        // helpers, NOT anything that takes it again. If a future refactor
        // reintroduced a re-lock, the second acquisition would hang — caught
        // here as a timeout rather than a wedged CI run.
        let tmp = tempfile::tempdir().unwrap();
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
        let results = crate::skills::tests::with_hermetic_home(
            tmp.path(),
            timeout(
                Duration::from_secs(5),
                experts_apply_links_core(&EventEmitter::Noop, ops),
            ),
        )
        .await
        .expect("experts_apply_links must not deadlock")
        .expect("batch returns Ok");
        assert_eq!(results.len(), 2);
        // Disabling an already-absent link is an idempotent success.
        assert!(results.iter().all(|r| r.ok), "{results:?}");
    }

    #[cfg(not(windows))] // a home of its own: `skills::tests::with_hermetic_home`
    #[tokio::test]
    async fn apply_links_collects_per_op_results_without_aborting() {
        let tmp = tempfile::tempdir().unwrap();
        let ops = vec![
            LinkOp {
                expert_id: "zzz-codeg-batch-test-absent".into(),
                agent_type: AgentType::ClaudeCode,
                enable: false,
            },
            LinkOp {
                // Unknown expert → enable fails before any fs write.
                expert_id: "zzz-unknown-expert".into(),
                agent_type: AgentType::ClaudeCode,
                enable: true,
            },
        ];
        let results = crate::skills::tests::with_hermetic_home(
            tmp.path(),
            experts_apply_links_core(&EventEmitter::Noop, ops),
        )
        .await
        .expect("batch returns Ok");
        assert_eq!(results.len(), 2);
        assert!(results[0].ok, "idempotent disable should succeed");
        assert!(!results[1].ok, "unknown expert enable should fail its op");
        assert!(results[1].error.is_some());
        assert_eq!(results[1].code.as_deref(), Some("skill_not_found"));
        assert!(results[1].status.is_none());
    }

    #[cfg(not(windows))] // a home of its own: `skills::tests::with_hermetic_home`
    #[tokio::test]
    // The hydrate guard is held across the await on purpose — see the
    // identical note in `custom_agent_service`.
    #[allow(clippy::await_holding_lock)]
    async fn list_all_install_statuses_covers_every_expert_agent_pair() {
        // A test hydrating a custom agent that declares a store would add a
        // column between the snapshot and the count below.
        let _guard = crate::acp::custom_registry::hydrate_test_guard();
        let tmp = tempfile::tempdir().unwrap();
        let (rows, expected) = crate::skills::tests::with_hermetic_home(tmp.path(), async {
            let rows = experts_list_all_install_statuses()
                .await
                .expect("snapshot returns Ok");
            (rows, bundled_metadata().len() * supported_agents().len())
        })
        .await;
        assert_eq!(rows.len(), expected);
    }
}
