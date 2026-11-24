//! Built-in scientific-research skills management.
//!
//! Science skills (curated from K-Dense-AI/scientific-agent-skills) are
//! bundled into the binary via `include_dir!` and, on startup, extracted into
//! the same central store as experts — `~/.codeg/skills/<id>/`. Users enable a
//! science skill for any ACP agent by symlinking (or Windows-junctioning) the
//! agent's skill dir into the central copy.
//!
//! Extraction, linking and status go through the skills engine
//! (`crate::skills`), exactly as for Experts; what is Science's own is its
//! `SCIENCE_BUNDLE`, its manifest `.manifest.science.json` (so it never
//! clobbers experts' `.manifest.json`), its `supported_agents`, and four extra
//! `science.toml` fields (featured/accent/needs_key/needs_env). Link statuses
//! reuse the Experts DTOs, so they serialize identically and the frontend
//! enablement merge stays uniform.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::OnceLock;

use include_dir::{include_dir, Dir};
use serde::{Deserialize, Serialize};

use crate::app_error::AppCommandError;
use crate::commands::acp::{skill_storage_spec, validate_skill_id};
use crate::commands::experts::{central_experts_dir, ExpertInstallStatus, LinkOp, LinkOpResult};
use crate::models::agent::AgentType;
use crate::skills::model::SkillOrigin;
use crate::skills::packs::{self, Bundle};
use crate::skills::{legacy, SkillsCtx};
use crate::web::event_bridge::EventEmitter;

pub use crate::skills::packs::InstallReport;

// ─── Embedded bundle ────────────────────────────────────────────────────

static SCIENCE_BUNDLE: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/science");

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

impl ScienceError {
    pub fn code(&self) -> &'static str {
        use crate::skills::model::codes;
        match self {
            ScienceError::NotFound(_) | ScienceError::CentralUnavailable(_) => {
                codes::SKILL_NOT_FOUND
            }
            ScienceError::UnsupportedAgent(_) => codes::AGENT_UNSUPPORTED,
            ScienceError::NameCollision { .. } => codes::TARGET_OCCUPIED,
            ScienceError::ForeignLink { .. } => codes::TARGET_LINKED_ELSEWHERE,
            ScienceError::Io(_) => codes::IO_ERROR,
            ScienceError::Metadata(_) => codes::SKILL_INVALID,
        }
    }
}

impl From<&ScienceError> for AppCommandError {
    fn from(error: &ScienceError) -> Self {
        crate::skills::coded_error(
            AppCommandError::task_execution_failed(error.to_string()),
            error.code(),
            None,
        )
    }
}

/// On both transports an error is an `AppCommandError` with its stable code.
impl Serialize for ScienceError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        AppCommandError::from(self).serialize(serializer)
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
    /// The store holds a skill of another origin under this id: the science
    /// skill is not installed, and not linked.
    pub name_taken: bool,
}

// ─── Paths ──────────────────────────────────────────────────────────────

fn science_central_path(skill_id: &str) -> PathBuf {
    central_experts_dir().join(skill_id)
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
        let bundled_hash = packs::bundled_hash(&SCIENCE_BUNDLE, &entry.id)
            .ok_or_else(|| ScienceError::NotFound(entry.id.clone()))?;
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

/// Ids of all bundled science skills. Used by the custom-skills pack to keep
/// built-in ids out of new custom skills, and by the engine's "name taken".
pub(crate) fn bundled_ids() -> Vec<String> {
    bundled_metadata().iter().map(|m| m.id.clone()).collect()
}

fn find_metadata(skill_id: &str) -> Result<&'static ScienceMetadata, ScienceError> {
    bundled_metadata()
        .iter()
        .find(|m| m.id == skill_id)
        .ok_or_else(|| ScienceError::NotFound(skill_id.to_string()))
}

// ─── Central store installation ────────────────────────────────────────

fn bundle() -> Bundle<'static> {
    Bundle {
        origin: SkillOrigin::Science,
        dir: &SCIENCE_BUNDLE,
        skills: bundled_metadata()
            .iter()
            .map(|m| (m.id.clone(), m.bundled_hash.clone()))
            .collect(),
    }
}

/// Extract or update the bundled science skills in `ctx`'s store, under the
/// skills lock. Blocking.
pub(crate) fn install_in(ctx: &SkillsCtx) -> InstallReport {
    match ctx.lock_blocking() {
        Ok(_guard) => packs::install_bundle(ctx, &bundle()),
        Err(err) => InstallReport {
            errors: vec![format!("skills lock: {err}")],
            ..InstallReport::default()
        },
    }
}

pub async fn ensure_central_science_installed() -> InstallReport {
    tokio::task::spawn_blocking(|| install_in(&SkillsCtx::user()))
        .await
        .unwrap_or_else(|e| InstallReport {
            errors: vec![format!("join error: {e}")],
            ..InstallReport::default()
        })
}

// ─── Commands: list / status ────────────────────────────────────────────

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn science_list() -> Result<Vec<ScienceListItem>, ScienceError> {
    let store = central_experts_dir();
    let provenance = crate::skills::provenance::Provenance::load(&store);
    let mut out = Vec::new();
    for meta in bundled_metadata().iter().cloned() {
        let central_path = science_central_path(&meta.id);
        let present = central_path.exists();
        let ours = provenance.origin_of(&store, &meta.id) == Some(SkillOrigin::Science);
        out.push(ScienceListItem {
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

// ─── Commands: link / unlink ────────────────────────────────────────────

/// Apply a batch of enable/disable operations under the skills lock. Each op
/// is applied independently: a failing op records `ok: false` (with a code)
/// and the batch continues. See `experts_apply_links_core` for what is
/// refused here and done on the Harness page instead.
pub async fn science_apply_links_core(
    emitter: &EventEmitter,
    ops: Vec<LinkOp>,
) -> Result<Vec<LinkOpResult>, ScienceError> {
    let ctx = SkillsCtx::user();
    let guard = match ctx.lock().await {
        Ok(guard) => guard,
        Err(err) => return Ok(legacy::busy(&ops, &err)),
    };
    let task_ctx = ctx.clone();
    let (results, changed) = tokio::task::spawn_blocking(move || {
        let _guard = guard;
        // As before: enabling needs a skill of the bundle; disabling an id
        // that is not one is an idempotent success.
        legacy::apply_ops(&task_ctx, SkillOrigin::Science, &ops, |id, enable| {
            (enable && find_metadata(id).is_err())
                .then(|| ScienceError::NotFound(id.to_string()).to_string())
        })
    })
    .await
    .map_err(|e| ScienceError::Io(format!("join error: {e}")))?;
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
pub async fn science_apply_links(
    ops: Vec<LinkOp>,
    app: tauri::AppHandle,
) -> Result<Vec<LinkOpResult>, ScienceError> {
    science_apply_links_core(&EventEmitter::from_app(&app), ops).await
}

/// One-shot snapshot of every (science skill, agent) link state — lets the
/// matrix UI render the whole grid from a single round-trip.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn science_list_all_install_statuses() -> Result<Vec<ExpertInstallStatus>, ScienceError> {
    let ids = bundled_ids();
    let agents = supported_agents();
    tokio::task::spawn_blocking(move || {
        legacy::statuses(&SkillsCtx::user(), SkillOrigin::Science, &ids, &agents)
    })
    .await
    .map_err(|e| ScienceError::Io(format!("join error: {e}")))
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

    #[cfg(not(windows))] // only the hermetic-home tests below
    use tokio::time::{timeout, Duration};

    // These tests run against a home of their own (`with_hermetic_home`), and
    // use ids that are well-formed but absent from the bundle.

    #[cfg(not(windows))] // a home of its own: `skills::tests::with_hermetic_home`
    #[tokio::test]
    async fn apply_links_does_not_deadlock() {
        let tmp = tempfile::tempdir().unwrap();
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
        let results = crate::skills::tests::with_hermetic_home(
            tmp.path(),
            timeout(
                Duration::from_secs(5),
                science_apply_links_core(&EventEmitter::Noop, ops),
            ),
        )
        .await
        .expect("science_apply_links must not deadlock")
        .expect("batch returns Ok");
        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|r| r.ok), "{results:?}");
    }

    #[cfg(not(windows))] // a home of its own: `skills::tests::with_hermetic_home`
    #[tokio::test]
    async fn apply_links_collects_per_op_results_without_aborting() {
        let tmp = tempfile::tempdir().unwrap();
        let ops = vec![
            LinkOp {
                expert_id: "zzz-codeg-science-batch-absent".into(),
                agent_type: AgentType::ClaudeCode,
                enable: false,
            },
            LinkOp {
                // Unknown skill → enable fails before any fs write.
                expert_id: "zzz-unknown-science-skill".into(),
                agent_type: AgentType::ClaudeCode,
                enable: true,
            },
        ];
        let results = crate::skills::tests::with_hermetic_home(
            tmp.path(),
            science_apply_links_core(&EventEmitter::Noop, ops),
        )
        .await
        .expect("batch returns Ok");
        assert_eq!(results.len(), 2);
        assert!(results[0].ok, "idempotent disable should succeed");
        assert!(!results[1].ok, "unknown skill enable should fail its op");
        assert!(results[1].error.is_some());
        assert!(results[1].status.is_none());
    }

    #[cfg(not(windows))] // a home of its own: `skills::tests::with_hermetic_home`
    #[tokio::test]
    // The hydrate guard is held across the await on purpose — see the
    // identical note in `custom_agent_service`.
    #[allow(clippy::await_holding_lock)]
    async fn list_all_install_statuses_covers_every_skill_agent_pair() {
        // A test hydrating a custom agent that declares a store would add a
        // column between the snapshot and the count below.
        let _guard = crate::acp::custom_registry::hydrate_test_guard();
        let tmp = tempfile::tempdir().unwrap();
        let (rows, expected) = crate::skills::tests::with_hermetic_home(tmp.path(), async {
            let rows = science_list_all_install_statuses()
                .await
                .expect("snapshot returns Ok");
            (rows, bundled_metadata().len() * supported_agents().len())
        })
        .await;
        assert_eq!(rows.len(), expected);
    }

    /// #718: the matrix renders a column per `skills_capable` agent, but the
    /// backend snapshot came from a hand-maintained subset. Antigravity had a
    /// column and no row, so the authoritative refresh that follows a toggle
    /// read the freshly linked cell back as unlinked and flipped it off — and
    /// the re-enable then collided with the link the first one had created.
    /// The status snapshot must therefore cover every built-in that declares
    /// a skill store. (The single-skill `science_get_install_status` it also
    /// checked had no caller and was removed with the engine.)
    ///
    /// Built-ins only: `all_acp_agents()` also reads the process-global custom
    /// registry, which `a_declared_custom_agent_gains_a_column_here_too`
    /// rewrites from another test thread.
    #[cfg(not(windows))] // a home of its own: `skills::tests::with_hermetic_home`
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
        assert!(
            expected.contains(&AgentType::Kiro),
            "Kiro declares a skill store, so it is one of the columns"
        );
        assert!(
            expected.contains(&AgentType::Trae),
            "TRAE CLI declares a skill store, so it is one of the columns"
        );
        assert!(
            expected.contains(&AgentType::CommandCode),
            "Command Code declares a skill store, so it is one of the columns"
        );

        let tmp = tempfile::tempdir().unwrap();
        let whole_grid: Vec<AgentType> =
            crate::skills::tests::with_hermetic_home(tmp.path(), async {
                science_list_all_install_statuses()
                    .await
                    .expect("snapshot returns Ok")
            })
            .await
            .into_iter()
            .map(|row| row.agent_type)
            .collect();

        for agent in expected {
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
