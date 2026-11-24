//! Installing, updating and uninstalling skills from Harness (plan §7.3).
//!
//! Every write goes through the skills engine (`crate::skills`): its lock,
//! its atomic writes, its backups, its link planning (with the `ack` that
//! confirms effects on other agents) and its copies. What this module adds
//! is the package and the journal:
//!
//! 1. **Plan** ([`plan`]): the version's install info (description, file
//!    list, archive hash, source — what never changes about a revision) and
//!    its `/resolve` snapshot (status, risk, review, permissions, checks,
//!    package verification, fingerprint — read fresh); what blocks the item,
//!    what must be confirmed (`yanked`) or said; the install name and what
//!    holds the others; the agents to link to, with the engine's preflight
//!    of those links (as if the skill were in the store already); for an
//!    installed item, what is installed and which files the user changed.
//! 2. **Install** ([`install`]), with what the user confirmed: the call and
//!    the name checked; the links' effects checked against the confirmed
//!    `ack`s; the package downloaded and every file checked (in memory,
//!    within `/config`'s limits); `SKILL.md` rewritten. Then, under the
//!    skills lock: everything checked again, the folder staged and the
//!    operation journaled ([`journal`]); the snapshot read once more and
//!    compared by fingerprint — the last check before anything in the store
//!    moves; the folder swapped in and committed with its manifest entry; the
//!    links made through the engine. An update keeps a folder the user
//!    changed among the backups, and refreshes Codeg's copies that still
//!    match.
//! 3. **Uninstall** ([`uninstall`]): a preflight (what is removed where, who
//!    stops seeing it, which changed copies stay, which changed files are
//!    kept as a backup) with its `ack`; then, under the lock: journal,
//!    unlink, the folder out, the manifest committed, the folder deleted.
//! 4. **Listing** ([`installed_skills`]): the manifest against the disk.
//!
//! The plan and the install need the catalog (`CODEG_HARNESS=off` refuses
//! them); the listing, the uninstall and the startup recovery
//! ([`recover_journals`]) touch only this machine. Nothing installs except
//! through [`install`], called with a person's confirmation; `codeg-mcp`
//! exposes none of this.

pub(crate) mod frontmatter;
pub(crate) mod journal;
pub(crate) mod manifest;
pub mod model;
pub(crate) mod names;
// Called by the plugins module's install (the next step).
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) mod owned;
pub(crate) mod package;

#[cfg(test)]
mod owned_tests;
#[cfg(test)]
pub(crate) mod tests;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::app_error::{AppCommandError, AppErrorCode};
use crate::db::AppDatabase;
use crate::harness::mcp::model::{codes as shared, LocalState, PlanItem, Reason};
use crate::harness::mcp::snapshot;
use crate::harness::types::{Installed, Kind, Resolved, Verified, VersionState, VersionStatus};
use crate::models::agent::AgentType;
use crate::skills::apply::{apply_blocking, preflight_pending};
use crate::skills::model::{
    codes as skill_codes, ChangeKind, ChangedKind, OpStatus, SkillAction, SkillOp, SkillOpResult,
    SkillsApplyRequest, SkillsApplyResult, SkillsIssue,
};
use crate::skills::world::{Entry, World};
use crate::skills::SkillsCtx;
use crate::web::event_bridge::{emit_event, EventEmitter};

use super::error::HarnessError;
use super::{Harness, ItemRef, Origin};

use journal::{new_journal, Action, Tx};
pub use journal::{recover_journals, RecoveryReport};
use manifest::{Manifest, ManifestEntry};
pub use model::*;
use package::PackageFile;

/// The event H4 announces record changes with; skills use it too.
pub use crate::harness::mcp::model::INSTALLED_CHANGED_EVENT;

/// The local side: Codeg's skill store and the agents' directories (the
/// engine's context), which agents are installed here, and the host the
/// files of a package without an archive come from. Made per command; a
/// test points all of it at temporary directories and a stand-in host.
#[derive(Clone)]
pub(crate) struct Local {
    pub ctx: SkillsCtx,
    pub installed: BTreeMap<AgentType, bool>,
    pub raw_origin: Origin,
}

impl Local {
    /// With which agents are installed here: what the plan's defaults need.
    pub(crate) async fn from_db(db: &AppDatabase) -> Self {
        Self {
            installed: installed_agents(db).await,
            ..Self::here()
        }
    }

    /// This machine's store and agents, without asking which agents are
    /// installed (the install and the uninstall do not need it).
    pub(crate) fn here() -> Self {
        Self {
            ctx: SkillsCtx::user(),
            installed: BTreeMap::new(),
            raw_origin: Origin::parse(package::RAW_ORIGIN).expect("the raw host is an origin"),
        }
    }
}

/// Which agents are on this machine, as the skills matrix decides: an
/// installed built-in or any custom agent — and not a pi pointed at its own
/// agent directory (Codeg's store links into the default one, which that pi
/// does not read). Empty when it cannot be told.
async fn installed_agents(db: &AppDatabase) -> BTreeMap<AgentType, bool> {
    match crate::commands::acp::acp_list_agents_core(db).await {
        Ok(listed) => listed
            .into_iter()
            .map(|agent| {
                let pi_elsewhere = agent.agent_type == AgentType::Pi
                    && agent
                        .env
                        .get("PI_CODING_AGENT_DIR")
                        .is_some_and(|dir| !dir.trim().is_empty());
                let installed = agent.installed_version.is_some() || agent.custom_source.is_some();
                (agent.agent_type, installed && !pi_elsewhere)
            })
            .collect(),
        Err(error) => {
            tracing::warn!("[Harness skills] could not tell which agents are installed: {error}");
            BTreeMap::new()
        }
    }
}

async fn off_thread<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, AppCommandError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| AppCommandError::task_execution_failed(format!("Harness skills: {e}")))
}

fn manifest_reason(error: &manifest::ManifestError) -> Reason {
    Reason::new(codes::MANIFEST_UNREADABLE).detail(error.detail())
}

fn wire_agent(agent: AgentType) -> String {
    agent.as_wire().into_owned()
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(crate) async fn latest_revision(
    harness: &Harness,
    item_ref: &ItemRef,
) -> Result<u64, HarnessError> {
    let item = harness.item(&item_ref.to_string()).await?;
    item.get("latest")
        .and_then(|latest| latest.get("revision"))
        .and_then(Value::as_u64)
        .filter(|revision| *revision > 0)
        .ok_or_else(|| HarnessError::invalid_response("the item names no latest revision"))
}

pub(crate) async fn resolve_one(
    harness: &Harness,
    id: &str,
    revision: u64,
) -> Result<Resolved, HarnessError> {
    harness
        .resolve(&[Installed {
            id: id.to_string(),
            revision,
        }])
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| HarnessError::invalid_response("/resolve answered nothing"))
}

/// What the snapshot's packages make of the item: blocking reasons (no
/// exact version, `missing`, a verification this Codeg does not know) and
/// warnings (not verified yet, install scripts).
pub(crate) fn package_reasons(state: Option<&VersionState>) -> (Vec<Reason>, Vec<Reason>) {
    let mut blocking = Vec::new();
    let mut warnings = Vec::new();
    let Some(state) = state else {
        return (blocking, warnings);
    };
    for package in state.packages.iter().flatten() {
        let version = package.version.clone().unwrap_or_default();
        let reason = |code: &str| {
            Reason::new(code)
                .param("registry_type", package.registry_type.clone())
                .param("identifier", package.identifier.clone())
                .param("version", version.clone())
        };
        if !crate::harness::mcp::is_exact_version(&package.registry_type, &version) {
            blocking.push(reason(shared::PACKAGE_VERSION_INEXACT));
        }
        match package.verified {
            Verified::Ok => {}
            Verified::Missing => blocking.push(reason(shared::PACKAGE_MISSING)),
            Verified::Pending => {
                warnings.push(reason(shared::VERSION_UNVERIFIED).param("verified", "pending"))
            }
            Verified::Unchecked => {
                warnings.push(reason(shared::VERSION_UNVERIFIED).param("verified", "unchecked"))
            }
            Verified::Unknown => blocking.push(reason(shared::PACKAGE_VERIFICATION_UNKNOWN)),
        }
        let named = format!("{}:{}", package.registry_type, package.identifier);
        let in_profile = state.permissions.as_ref().is_some_and(|profile| {
            [&profile.declared, &profile.detected].iter().any(|listed| {
                listed
                    .install_scripts
                    .iter()
                    .any(|entry| entry.eq_ignore_ascii_case(&named))
            })
        });
        if package.has_install_script || in_profile {
            warnings.push(
                Reason::new(shared::INSTALL_SCRIPT)
                    .param("registry_type", package.registry_type.clone())
                    .param("identifier", package.identifier.clone()),
            );
        }
    }
    (blocking, warnings)
}

/// Why the item as a whole cannot be installed now, by the fresh snapshot.
fn snapshot_blocking(resolved: &Resolved, revision: u64) -> Vec<Reason> {
    let mut out = snapshot::item_blocking_as(resolved, revision, Kind::Skill, codes::NOT_A_SKILL);
    if out.is_empty() {
        out.extend(package_reasons(resolved.installed.as_ref()).0);
    }
    out
}

fn push_unique(into: &mut Vec<Reason>, reasons: impl IntoIterator<Item = Reason>) {
    for reason in reasons {
        if !into.contains(&reason) {
            into.push(reason);
        }
    }
}

// ─── What is installed ──────────────────────────────────────────────────

/// The files of the folder at `live` against what the manifest says was
/// installed. `Err` when the folder cannot be read.
pub(crate) fn file_changes(live: &Path, entry: &ManifestEntry) -> std::io::Result<FileChanges> {
    use crate::skills::fsio::is_ignored_rel;
    let mut out = FileChanges::default();
    let recorded = entry.files.iter().filter(|(path, _)| !is_ignored_rel(path));
    if !fs::metadata(live).is_ok_and(|meta| meta.is_dir()) {
        out.missing = recorded.map(|(path, _)| path.clone()).collect();
        return Ok(out);
    }
    let on_disk = crate::skills::fsio::tree_files(live)?;
    let present: BTreeSet<&str> = on_disk.iter().map(|(rel, _)| rel.as_str()).collect();
    for (rel, path) in &on_disk {
        match entry.files.get(rel) {
            Some(sha) => {
                if sha256_hex(&fs::read(path)?) != *sha {
                    out.changed.push(rel.clone());
                }
            }
            None => out.added.push(rel.clone()),
        }
    }
    out.missing = recorded
        .filter(|(path, _)| !present.contains(path.as_str()))
        .map(|(path, _)| path.clone())
        .collect();
    Ok(out)
}

fn state_of(changes: &std::io::Result<FileChanges>) -> LocalState {
    match changes {
        Err(_) => LocalState::Unknown,
        Ok(changes) if !changes.missing.is_empty() => LocalState::Missing,
        Ok(changes) if !changes.changed.is_empty() || !changes.added.is_empty() => {
            LocalState::ChangedLocally
        }
        Ok(_) => LocalState::AsInstalled,
    }
}

fn listed(world: &World<'_>, name: &str, entry: &ManifestEntry) -> InstalledSkill {
    let changes = file_changes(&world.ctx.skill_path(name), entry);
    InstalledSkill {
        id: entry.item_id.clone(),
        item_ref: entry.item_ref.clone(),
        name: name.to_string(),
        revision: entry.revision,
        version: entry.version.clone(),
        state: state_of(&changes),
        agents: world.seen_by(name),
        files: changes.unwrap_or_default(),
        rewrites: entry.rewrites.clone(),
        archive_sha256: entry.archive_sha256.clone(),
        state_sha256: entry.state_sha256.clone(),
        installed_at: entry.installed_at.clone(),
    }
}

fn record_unreadable(error: &manifest::ManifestError) -> AppCommandError {
    AppCommandError::new(
        AppErrorCode::IoError,
        "the record of the skills Codeg installed from Harness cannot be read",
    )
    .with_detail(error.detail())
    .with_i18n(
        crate::harness::mcp::I18N_KEY_RECORD_UNREADABLE,
        BTreeMap::new(),
    )
}

/// Every skill installed from Harness, against the disk now. Reads only.
pub(crate) fn installed_skills_in(ctx: &SkillsCtx) -> Result<Vec<InstalledSkill>, AppCommandError> {
    let manifest = manifest::load(&ctx.store).map_err(|error| record_unreadable(&error))?;
    let world = World::load(ctx);
    Ok(manifest
        .skills
        .iter()
        .filter(|(_, entry)| entry.plugin.is_none())
        .map(|(name, entry)| listed(&world, name, entry))
        .collect())
}

/// The listing behind `harness_installed`'s `skills`.
pub(crate) async fn installed_skills(
    ctx: SkillsCtx,
) -> Result<Vec<InstalledSkill>, AppCommandError> {
    off_thread(move || installed_skills_in(&ctx)).await?
}

// ─── harness_skill_plan ─────────────────────────────────────────────────

fn enable_ops(
    name: &str,
    agents: &[AgentType],
    acks: &BTreeMap<AgentType, String>,
) -> Vec<SkillOp> {
    agents
        .iter()
        .map(|agent| SkillOp {
            skill: name.to_string(),
            agent: *agent,
            action: SkillAction::Enable,
            ack: acks.get(agent).cloned(),
            replace_modified: false,
        })
        .collect()
}

fn dedupe(agents: &[AgentType]) -> Vec<AgentType> {
    let mut out: Vec<AgentType> = Vec::new();
    for agent in agents {
        if !out.contains(agent) {
            out.push(*agent);
        }
    }
    out
}

struct LocalPlan {
    install_name: NamePlan,
    agents: Vec<PlanAgent>,
    default_agents: Vec<AgentType>,
    links: SkillsApplyResult,
    installed: Option<InstalledSkill>,
    manifest_problem: Option<Reason>,
}

fn local_plan(
    local: &Local,
    item_id: &str,
    base: &str,
    publisher: &str,
    asked: Option<Vec<AgentType>>,
) -> LocalPlan {
    let ctx = &local.ctx;
    let (manifest, manifest_problem) = match manifest::load(&ctx.store) {
        Ok(manifest) => (manifest, None),
        Err(error) => (Manifest::default(), Some(manifest_reason(&error))),
    };
    let world = World::load(ctx);
    let recorded = manifest
        .find_item(item_id)
        .map(|(name, entry)| (name.clone(), entry.clone()));
    let installed = recorded
        .as_ref()
        .map(|(name, entry)| listed(&world, name, entry));
    let default_agents: Vec<AgentType> = match &recorded {
        Some((name, _)) => world.seen_by(name),
        None => ctx
            .agents
            .iter()
            .map(|agent| agent.agent)
            .filter(|agent| local.installed.get(agent).copied().unwrap_or(false))
            .collect(),
    };
    let mut taken: Vec<NameTaken> = Vec::new();
    let default = match &recorded {
        Some((name, _)) => name.clone(),
        None => {
            let tried = std::cell::RefCell::new(Vec::new());
            let name = names::first_free(base, publisher, |candidate| {
                let holders =
                    names::holders(&world, &manifest, candidate, item_id, &default_agents);
                let held = !holders.is_empty();
                tried.borrow_mut().extend(holders);
                held
            });
            taken = tried.into_inner();
            name
        }
    };
    if recorded.is_some() {
        taken = names::holders(&world, &manifest, &default, item_id, &default_agents);
    }
    let agents = ctx
        .agents
        .iter()
        .map(|agent| {
            let link_dir = ctx.link_dir(agent.agent);
            PlanAgent {
                agent: agent.agent,
                installed: local.installed.get(&agent.agent).copied(),
                link_dir_shared: link_dir.as_ref().is_some_and(|(_, shared)| *shared),
                link_dir: link_dir.map(|(dir, _)| dir.to_string_lossy().into_owned()),
                sees: world.visible(agent.agent, &default).is_some(),
                default: default_agents.contains(&agent.agent),
            }
        })
        .collect();
    let asked = dedupe(&asked.unwrap_or_else(|| default_agents.clone()));
    let links = preflight_pending(
        ctx,
        enable_ops(&default, &asked, &BTreeMap::new()),
        BTreeSet::from([default.clone()]),
    );
    LocalPlan {
        install_name: NamePlan {
            name: base.to_string(),
            default,
            taken,
            pattern: names::PATTERN.to_string(),
        },
        agents,
        default_agents,
        links,
        installed,
        manifest_problem,
    }
}

/// Everything the install dialog shows, in one answer. `agents`: the agents
/// whose links to preflight (default: the default ones). Fails only when
/// the catalog cannot be asked; everything about the item is in the answer.
pub(crate) async fn plan(
    local: &Local,
    harness: &Harness,
    item_ref: &str,
    revision: Option<u64>,
    agents: Option<Vec<AgentType>>,
) -> Result<HarnessSkillPlan, AppCommandError> {
    harness.ensure_enabled()?;
    let item_ref = ItemRef::parse(item_ref)?;
    let revision = match revision {
        Some(0) => return Err(HarnessError::InvalidRef.into()),
        Some(revision) => revision,
        None => latest_revision(harness, &item_ref).await?,
    };
    let info = harness.install_info(&item_ref, revision).await?;
    let resolved = resolve_one(harness, &info.item.id, revision).await?;
    let snapshot_state = resolved.installed.clone();
    if let Some(state) = &snapshot_state {
        snapshot::remember(state);
    }
    let limits = package::limits_from_config(&harness.config().await?);

    let mut blocking = Vec::new();
    if info.item.kind != Kind::Skill {
        blocking
            .push(Reason::new(codes::NOT_A_SKILL).param("kind", snapshot::wire(&info.item.kind)));
    }
    push_unique(&mut blocking, snapshot_blocking(&resolved, revision));
    push_unique(
        &mut blocking,
        package::check_listing(&info, &harness.origin, &limits),
    );
    let mut warnings = package_reasons(snapshot_state.as_ref()).1;
    if info.archive.is_none() {
        if let Some(source) = &info.source {
            warnings.push(
                Reason::new(codes::FETCHED_FROM_SOURCE)
                    .param("repository", source.repository.clone())
                    .param("commit", source.commit.clone()),
            );
        }
    }
    let skill = PlanSkill {
        name: info
            .skill
            .as_ref()
            .map(|skill| skill.name.clone())
            .unwrap_or_else(|| item_ref.name().to_string()),
        description: info
            .skill
            .as_ref()
            .map(|skill| skill.description.clone())
            .unwrap_or_default(),
        license: info.skill.as_ref().and_then(|skill| skill.license.clone()),
        compatibility: info
            .skill
            .as_ref()
            .and_then(|skill| skill.compatibility.clone()),
        allowed_tools: info
            .skill
            .as_ref()
            .and_then(|skill| skill.allowed_tools.clone()),
    };
    if let Some(tools) = skill
        .allowed_tools
        .as_ref()
        .filter(|tools| !tools.is_empty())
    {
        warnings.push(Reason::new(codes::ALLOWED_TOOLS).param("tools", tools.join(", ")));
    }

    let base = names::base_name(
        info.skill.as_ref().map(|s| s.name.as_str()),
        item_ref.name(),
    );
    let task_local = local.clone();
    let item_id = info.item.id.clone();
    let publisher = item_ref.publisher().to_string();
    let base_for_plan = base.clone();
    let planned =
        off_thread(move || local_plan(&task_local, &item_id, &base_for_plan, &publisher, agents))
            .await?;
    if let Some(problem) = planned.manifest_problem.clone() {
        blocking.push(problem);
    }
    if let Some(installed) = &planned.installed {
        if installed.state == LocalState::Unknown {
            warnings.push(Reason::new(codes::FILES_UNREADABLE));
        }
        let count = installed.files.changed.len() + installed.files.added.len();
        if count > 0 {
            warnings
                .push(Reason::new(codes::FILES_CHANGED_LOCALLY).param("count", count.to_string()));
        }
    }
    let total_bytes = info.files.iter().map(|file| file.size).sum();
    Ok(HarnessSkillPlan {
        item: PlanItem {
            id: info.item.id.clone(),
            item_ref: info.item.r#ref.clone(),
            kind: info.item.kind,
            title: info.item.title.clone(),
            revision,
            version: info.version.version.clone(),
            published_at: info.version.published_at.clone(),
        },
        item_status: resolved.status,
        latest: resolved.latest.clone(),
        state_sha256: snapshot_state
            .as_ref()
            .and_then(|state| state.state_sha256.clone()),
        confirm: snapshot::confirmations(snapshot_state.as_ref()),
        snapshot: snapshot_state,
        blocking,
        warnings,
        skill,
        package: PlanPackage {
            archive: info.archive.clone(),
            source: info.source.clone(),
            files: info.files.clone(),
            total_bytes,
            limits,
        },
        install_name: planned.install_name,
        agents: planned.agents,
        default_agents: planned.default_agents,
        links: planned.links,
        installed: planned.installed,
    })
}

// ─── harness_skill_install ──────────────────────────────────────────────

impl HarnessSkillInstallResult {
    fn new(outcome: InstallOutcome) -> Self {
        Self {
            outcome,
            issues: Vec::new(),
            changes: Vec::new(),
            snapshot: None,
            state_sha256: None,
            name: None,
            phases: Vec::new(),
            links: None,
            links_skipped: Vec::new(),
            copies: None,
            backup: None,
            rewrites: None,
            kept: Vec::new(),
        }
    }

    fn refused(issues: Vec<Reason>) -> Self {
        Self {
            issues,
            ..Self::new(InstallOutcome::Refused)
        }
    }
}

/// The ops of `preflight` whose `ack` is not the one `acks` gives: a reason
/// each (`acknowledgement_required` / `effects_changed`, param `agent`).
fn unconfirmed(preflight: &SkillsApplyResult, acks: &BTreeMap<AgentType, String>) -> Vec<Reason> {
    preflight
        .ops
        .iter()
        .filter(|op| op.status != OpStatus::Blocked)
        .filter_map(|op| {
            let wanted = op.ack.as_ref()?;
            match acks.get(&op.agent) {
                Some(given) if given == wanted => None,
                Some(_) => Some(codes::EFFECTS_CHANGED),
                None => Some(codes::ACKNOWLEDGEMENT_REQUIRED),
            }
            .map(|code| Reason::new(code).param("agent", wire_agent(op.agent)))
        })
        .collect()
}

/// What the install has made ready before it takes the lock.
struct Prepared {
    name: String,
    item_id: String,
    item_ref: String,
    revision: u64,
    version: Option<String>,
    archive_sha256: Option<String>,
    source: Option<crate::harness::types::Source>,
    files: Vec<PackageFile>,
    rewrites: Rewrites,
    state_sha256: String,
    agents: Vec<AgentType>,
    acks: BTreeMap<AgentType, String>,
}

/// What the part under the lock reports, for the events.
#[derive(Default)]
struct Committed {
    /// Agents whose directories changed (links, copies).
    touched: Vec<AgentType>,
    store: bool,
    backup: bool,
    item_changed: bool,
}

/// Install (or update) with what the user confirmed. See the module docs
/// for the order; every way back without writing is in the answer.
pub(crate) async fn install(
    local: &Local,
    harness: &Harness,
    emitter: &EventEmitter,
    request: HarnessSkillInstallRequest,
) -> Result<HarnessSkillInstallResult, AppCommandError> {
    harness.ensure_enabled()?;
    let item_ref = ItemRef::parse(&request.item_ref)?;
    if request.revision == 0 {
        return Err(HarnessError::InvalidRef.into());
    }
    let name = request.install_name.trim().to_string();
    let agents = dedupe(&request.agents);

    // The call itself, before anything is asked.
    let mut issues = Vec::new();
    if !names::is_valid(&name) {
        issues.push(Reason::new(codes::NAME_INVALID).param("name", name.clone()));
    }
    for agent in &agents {
        if local.ctx.agent(*agent).is_none() {
            issues.push(Reason::new(codes::AGENT_UNSUPPORTED).param("agent", wire_agent(*agent)));
        }
    }
    if !issues.is_empty() {
        return Ok(HarnessSkillInstallResult::refused(issues));
    }
    let store = local.ctx.store.clone();
    let manifest = match off_thread(move || manifest::load_for_write(&store)).await? {
        Ok(manifest) => manifest,
        Err(error) => {
            return Ok(HarnessSkillInstallResult::refused(vec![manifest_reason(
                &error,
            )]))
        }
    };

    // What never changes about the revision.
    let info = harness.install_info(&item_ref, request.revision).await?;
    if info.item.kind != Kind::Skill {
        return Ok(HarnessSkillInstallResult::refused(vec![Reason::new(
            codes::NOT_A_SKILL,
        )
        .param("kind", snapshot::wire(&info.item.kind))]));
    }
    if let Some((recorded, _)) = manifest.find_item(&info.item.id) {
        if *recorded != name {
            return Ok(HarnessSkillInstallResult::refused(vec![Reason::new(
                codes::INSTALLED_UNDER_OTHER_NAME,
            )
            .param("name", recorded.clone())]));
        }
    }
    let task_local = local.clone();
    let (task_name, task_id, task_agents) = (name.clone(), info.item.id.clone(), agents.clone());
    let refusals = off_thread(move || {
        let world = World::load(&task_local.ctx);
        let manifest = manifest::load(&task_local.ctx.store).unwrap_or_default();
        names::refusals(&names::holders(
            &world,
            &manifest,
            &task_name,
            &task_id,
            &task_agents,
        ))
    })
    .await?;
    if !refusals.is_empty() {
        return Ok(HarnessSkillInstallResult::refused(refusals));
    }
    let limits = package::limits_from_config(&harness.config().await?);
    let listing = package::check_listing(&info, &harness.origin, &limits);
    if !listing.is_empty() {
        return Ok(HarnessSkillInstallResult {
            issues: listing,
            name: Some(name),
            ..HarnessSkillInstallResult::new(InstallOutcome::InvalidPackage)
        });
    }

    // The links' effects, as confirmed.
    let task_ctx = local.ctx.clone();
    let ops = enable_ops(&name, &agents, &request.acks);
    let pending = BTreeSet::from([name.clone()]);
    let preflight = off_thread(move || preflight_pending(&task_ctx, ops, pending)).await?;
    let missing = unconfirmed(&preflight, &request.acks);
    if !missing.is_empty() {
        return Ok(HarnessSkillInstallResult {
            issues: missing,
            name: Some(name),
            links: Some(preflight),
            ..HarnessSkillInstallResult::new(InstallOutcome::AcknowledgementRequired)
        });
    }

    // The package, every byte checked.
    let mut phases = Vec::new();
    let files = match package::fetch(harness, &local.raw_origin, &info, &limits).await? {
        Ok(files) => files,
        Err(issues) => {
            phases.push(phase(Phase::Download, PhaseStatus::Done));
            phases.push(phase(Phase::Verify, PhaseStatus::Failed));
            return Ok(HarnessSkillInstallResult {
                issues,
                name: Some(name),
                phases,
                ..HarnessSkillInstallResult::new(InstallOutcome::InvalidPackage)
            });
        }
    };
    phases.push(phase(Phase::Download, PhaseStatus::Done));
    let mut files = files;
    let Some(skill_md) = files.iter_mut().find(|file| file.path == "SKILL.md") else {
        phases.push(phase(Phase::Verify, PhaseStatus::Failed));
        return Ok(HarnessSkillInstallResult {
            issues: vec![Reason::new(codes::SKILL_MD_MISSING)],
            name: Some(name),
            phases,
            ..HarnessSkillInstallResult::new(InstallOutcome::InvalidPackage)
        });
    };
    let rewrites = match frontmatter::rewrite(&skill_md.bytes, &name, request.keep_allowed_tools) {
        Ok(done) => {
            skill_md.bytes = done.bytes;
            done.rewrites
        }
        Err(detail) => {
            phases.push(phase(Phase::Verify, PhaseStatus::Failed));
            return Ok(HarnessSkillInstallResult {
                issues: vec![Reason::new(codes::SKILL_MD_INVALID).detail(detail)],
                name: Some(name),
                phases,
                ..HarnessSkillInstallResult::new(InstallOutcome::InvalidPackage)
            });
        }
    };
    phases.push(phase(Phase::Verify, PhaseStatus::Done));

    // Under the skills lock from here on: staged and journaled first, then
    // the snapshot read again — the last check before the swap — then the
    // swap, the commit and the links.
    let prepared = Prepared {
        name: name.clone(),
        item_id: info.item.id.clone(),
        item_ref: info.item.r#ref.clone(),
        revision: request.revision,
        version: info.version.version.clone(),
        archive_sha256: info.archive.as_ref().map(|archive| archive.sha256.clone()),
        source: if info.archive.is_none() {
            info.source.clone()
        } else {
            None
        },
        files,
        rewrites,
        state_sha256: request.state_sha256.clone(),
        agents,
        acks: request.acks.clone(),
    };
    let guard = match local.ctx.lock().await {
        Ok(guard) => guard,
        Err(error) => {
            return Ok(HarnessSkillInstallResult {
                issues: vec![Reason::new(error.code()).detail(error.to_string())],
                name: Some(name),
                phases,
                ..HarnessSkillInstallResult::new(InstallOutcome::Busy)
            })
        }
    };
    // The guard goes into each blocking step and comes back out of it: a
    // caller that goes away midway lets the lock go only between steps,
    // never while a step is moving something.
    let task_ctx = local.ctx.clone();
    let (guard, prepared, staged) = off_thread(move || {
        let staged = stage_install(&task_ctx, &prepared);
        (guard, prepared, staged)
    })
    .await?;
    let staged = match staged {
        Ok(staged) => staged,
        Err(result) => {
            let mut result = *result;
            phases.append(&mut result.phases);
            result.phases = phases;
            return Ok(result);
        }
    };
    phases.push(phase(Phase::Stage, PhaseStatus::Done));

    let stop = match resolve_one(harness, &info.item.id, request.revision).await {
        Ok(fresh) => snapshot_refusal(&fresh, &request).map(Ok),
        Err(error) => Some(Err(error)),
    };
    if let Some(stop) = stop {
        // Nothing has moved in the store: only the staging goes.
        let task_ctx = local.ctx.clone();
        let undone = off_thread(move || {
            let _guard = guard;
            Tx::resume(&task_ctx, staged.dir, staged.journal).rollback()
        })
        .await?;
        if let Err(failure) = &undone {
            tracing::warn!(
                "[Harness skills] the staged install could not be cleared ({}); kept: {:?}",
                failure.error,
                failure.kept
            );
        }
        let mut result = stop?;
        phases.push(phase(Phase::Snapshot, PhaseStatus::Failed));
        if let Some(stage) = phases.iter_mut().find(|done| done.phase == Phase::Stage) {
            stage.status = PhaseStatus::RolledBack;
        }
        if let Err(failure) = undone {
            result.kept = failure
                .kept
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect();
            result
                .issues
                .push(Reason::new(codes::ROLLBACK_FAILED).detail(failure.error.to_string()));
        }
        result.name = Some(name);
        result.phases = phases;
        return Ok(result);
    }
    phases.push(phase(Phase::Snapshot, PhaseStatus::Done));

    let task_ctx = local.ctx.clone();
    let (mut result, committed) = off_thread(move || {
        let _guard = guard;
        commit_install(&task_ctx, staged, prepared)
    })
    .await?;
    if result.outcome == InstallOutcome::WriteFailed && result.kept.is_empty() {
        for done in phases.iter_mut().filter(|done| done.phase == Phase::Stage) {
            done.status = PhaseStatus::RolledBack;
        }
    }
    phases.append(&mut result.phases);
    result.phases = phases;
    announce_install(local, emitter, &info.item.id, &name, &committed).await;
    Ok(result)
}

/// What the fresh snapshot stops, if anything: the item or version can no
/// longer be installed (`aborted`), its state is not the one confirmed
/// (`state_changed`), or it is yanked and that was not accepted.
fn snapshot_refusal(
    fresh: &Resolved,
    request: &HarnessSkillInstallRequest,
) -> Option<HarnessSkillInstallResult> {
    let abort = snapshot_blocking(fresh, request.revision);
    let state = match (abort.is_empty(), fresh.installed.clone()) {
        (true, Some(state)) => state,
        (_, state) => {
            let mut abort = abort;
            if abort.is_empty() {
                abort.push(
                    Reason::new(shared::REVISION_UNAVAILABLE)
                        .param("revision", request.revision.to_string()),
                );
            }
            return Some(HarnessSkillInstallResult {
                issues: abort,
                state_sha256: state.as_ref().and_then(|state| state.state_sha256.clone()),
                snapshot: state,
                ..HarnessSkillInstallResult::new(InstallOutcome::Aborted)
            });
        }
    };
    let fresh_sha = state.state_sha256.clone().unwrap_or_default();
    if fresh_sha != request.state_sha256 {
        snapshot::remember(&state);
        let confirmed = snapshot::recall(&request.state_sha256);
        return Some(HarnessSkillInstallResult {
            changes: snapshot::changes(confirmed.as_ref(), &state),
            snapshot: Some(state),
            state_sha256: Some(fresh_sha),
            ..HarnessSkillInstallResult::new(InstallOutcome::StateChanged)
        });
    }
    if state.status == VersionStatus::Yanked && !request.accept_yanked {
        return Some(HarnessSkillInstallResult::refused(vec![Reason::new(
            shared::YANKED_NOT_ACCEPTED,
        )]));
    }
    None
}

async fn announce_install(
    local: &Local,
    emitter: &EventEmitter,
    item_id: &str,
    name: &str,
    committed: &Committed,
) {
    if !committed.store && committed.touched.is_empty() && !committed.backup {
        return;
    }
    let ctx = local.ctx.clone();
    let task_name = name.to_string();
    let seen = off_thread(move || World::load(&ctx).seen_by(&task_name))
        .await
        .unwrap_or_default();
    let mut kinds = Vec::new();
    if committed.store {
        kinds.push(ChangedKind::Store);
    }
    if !committed.touched.is_empty() {
        kinds.push(ChangedKind::Links);
    }
    if committed.backup {
        kinds.push(ChangedKind::Backups);
    }
    let mut agents: Vec<AgentType> = seen.clone();
    agents.extend(committed.touched.iter().copied());
    crate::skills::announce(emitter, kinds, agents.clone());
    if committed.item_changed {
        agents.sort();
        agents.dedup();
        emit_event(
            emitter,
            INSTALLED_CHANGED_EVENT,
            SkillsInstalledChanged {
                item_ids: vec![item_id.to_string()],
                agents,
            },
        );
        crate::harness::updates::records_changed();
    }
}

fn rolled_back(
    mut result: HarnessSkillInstallResult,
    tx: &Tx<'_>,
    failed: Phase,
    issue: Reason,
) -> HarnessSkillInstallResult {
    result.outcome = InstallOutcome::WriteFailed;
    result.issues.push(issue);
    result.phases.push(phase(failed, PhaseStatus::Failed));
    match tx.rollback() {
        Ok(()) => {
            for done in result.phases.iter_mut() {
                if matches!(done.phase, Phase::Stage | Phase::Swap)
                    && done.status == PhaseStatus::Done
                {
                    done.status = PhaseStatus::RolledBack;
                }
            }
        }
        Err(failure) => {
            result.kept = failure
                .kept
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect();
            result
                .issues
                .push(Reason::new(codes::ROLLBACK_FAILED).detail(failure.error.to_string()));
        }
    }
    result
}

fn io_issue(code: &str, error: &std::io::Error) -> Reason {
    Reason::new(code).detail(error.to_string())
}

/// The operation, staged and journaled, waiting for the snapshot.
struct Staged {
    dir: PathBuf,
    journal: journal::Journal,
}

/// Under the lock: the checks again (another Codeg may have written since),
/// then the new folder staged and the operation journaled. Nothing in the
/// store has moved yet.
fn stage_install(
    ctx: &SkillsCtx,
    prepared: &Prepared,
) -> Result<Staged, Box<HarnessSkillInstallResult>> {
    let name = prepared.name.clone();
    let refused = |issues: Vec<Reason>| {
        Box::new(HarnessSkillInstallResult {
            name: Some(name.clone()),
            ..HarnessSkillInstallResult::refused(issues)
        })
    };
    let failed = |error: &std::io::Error| {
        Box::new(HarnessSkillInstallResult {
            issues: vec![io_issue(codes::IO_ERROR, error)],
            name: Some(name.clone()),
            phases: vec![phase(Phase::Stage, PhaseStatus::Failed)],
            ..HarnessSkillInstallResult::new(InstallOutcome::WriteFailed)
        })
    };

    let manifest =
        manifest::load_for_write(&ctx.store).map_err(|e| refused(vec![manifest_reason(&e)]))?;
    if let Some((recorded, _)) = manifest.find_item(&prepared.item_id) {
        if *recorded != name {
            return Err(refused(vec![Reason::new(
                codes::INSTALLED_UNDER_OTHER_NAME,
            )
            .param("name", recorded.clone())]));
        }
    }
    let world = World::load(ctx);
    let refusals = names::refusals(&names::holders(
        &world,
        &manifest,
        &name,
        &prepared.item_id,
        &prepared.agents,
    ));
    if !refusals.is_empty() {
        return Err(refused(refusals));
    }
    let preflight = preflight_pending(
        ctx,
        enable_ops(&name, &prepared.agents, &prepared.acks),
        BTreeSet::from([name.clone()]),
    );
    let missing = unconfirmed(&preflight, &prepared.acks);
    if !missing.is_empty() {
        return Err(Box::new(HarnessSkillInstallResult {
            issues: missing,
            name: Some(name.clone()),
            links: Some(preflight),
            ..HarnessSkillInstallResult::new(InstallOutcome::AcknowledgementRequired)
        }));
    }

    let before = manifest.skills.get(&name).cloned();
    let live = ctx.skill_path(&name);
    let had_old = fs::symlink_metadata(&live).is_ok();
    let keep_old = match (&before, had_old) {
        (Some(entry), true) => file_changes(&live, entry)
            .map(|changes| !changes.changed.is_empty() || !changes.added.is_empty())
            // A folder that cannot be read is not deleted: it is kept.
            .unwrap_or(true),
        // Something under the name that the manifest does not know as this
        // item's never gets here (`holders` refuses it).
        _ => false,
    };
    let action = if before.is_some() {
        Action::Update
    } else {
        Action::Install
    };
    let journal = new_journal(
        action,
        &name,
        &prepared.item_id,
        before,
        None,
        had_old,
        keep_old,
    );
    let mut tx = Tx::begin(ctx, journal).map_err(|e| failed(&e))?;
    match tx.stage(&prepared.files) {
        Ok(hash) => tx.journal.new_hash = Some(hash),
        Err(error) => {
            tx.discard();
            return Err(failed(&error));
        }
    }
    tx.journal.after = Some(ManifestEntry {
        item_id: prepared.item_id.clone(),
        item_ref: prepared.item_ref.clone(),
        revision: prepared.revision,
        version: prepared.version.clone(),
        archive_sha256: prepared.archive_sha256.clone(),
        source: prepared.source.clone(),
        files: prepared
            .files
            .iter()
            .map(|file| (file.path.clone(), sha256_hex(&file.bytes)))
            .collect(),
        rewrites: prepared.rewrites.clone(),
        // The fingerprint confirmed: the commit happens only if the fresh
        // snapshot still has it.
        state_sha256: prepared.state_sha256.clone(),
        installed_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        op: tx.journal.op.clone(),
        plugin: None,
        extra: serde_json::Map::new(),
    });
    if let Err(error) = tx.write_journal() {
        tx.discard();
        return Err(failed(&error));
    }
    let (dir, journal) = tx.into_parts();
    Ok(Staged { dir, journal })
}

/// Under the lock, after the snapshot: the swap, the commit, the cleaning,
/// then Codeg's copies and the links.
fn commit_install(
    ctx: &SkillsCtx,
    staged: Staged,
    prepared: Prepared,
) -> (HarnessSkillInstallResult, Committed) {
    let name = prepared.name.clone();
    let mut result = HarnessSkillInstallResult {
        name: Some(name.clone()),
        rewrites: Some(prepared.rewrites.clone()),
        ..HarnessSkillInstallResult::new(InstallOutcome::Installed)
    };
    let mut committed = Committed::default();
    let tx = Tx::resume(ctx, staged.dir, staged.journal);
    let action = tx.journal.action;
    let had_old = tx.journal.had_old;
    if let Err(error) = tx.swap() {
        let issue = io_issue(codes::IO_ERROR, &error);
        return (rolled_back(result, &tx, Phase::Swap, issue), committed);
    }
    result.phases.push(phase(Phase::Swap, PhaseStatus::Done));
    if let Err(error) = tx.commit() {
        let issue = io_issue(codes::MANIFEST_WRITE_FAILED, &error);
        return (rolled_back(result, &tx, Phase::Commit, issue), committed);
    }
    result.phases.push(phase(Phase::Commit, PhaseStatus::Done));
    committed.store = true;
    committed.item_changed = true;
    match tx.finish() {
        Ok(kept) => {
            result.phases.push(phase(
                Phase::Cleanup,
                if had_old {
                    PhaseStatus::Done
                } else {
                    PhaseStatus::Skipped
                },
            ));
            if let Some(path) = kept {
                committed.backup = true;
                result.phases.push(phase(Phase::Backup, PhaseStatus::Done));
                result.backup = Some(path.to_string_lossy().into_owned());
            }
        }
        Err(error) => {
            // Installed; what is left is the next start's to clean.
            result.phases.push(phase_detail(
                Phase::Cleanup,
                PhaseStatus::Failed,
                error.to_string(),
            ));
            result.kept.push(tx.dir.to_string_lossy().into_owned());
        }
    }

    // Codeg's copies of the old content, then the links.
    if action == Action::Update {
        let (copies, touched) = refresh_copies(ctx, &name);
        result.phases.push(phase(
            Phase::Copies,
            if copies.refreshed.is_empty() && copies.problems.is_empty() {
                PhaseStatus::Skipped
            } else if copies.problems.is_empty() {
                PhaseStatus::Done
            } else {
                PhaseStatus::Failed
            },
        ));
        committed.touched.extend(touched);
        result.copies = Some(copies);
    }
    let (links, skipped, touched) = link(ctx, &name, &prepared.agents, &prepared.acks);
    result.phases.push(phase(
        Phase::Links,
        if links.ops.is_empty() && skipped.is_empty() {
            PhaseStatus::Skipped
        } else if links.ok && skipped.is_empty() {
            PhaseStatus::Done
        } else {
            PhaseStatus::Failed
        },
    ));
    committed.touched.extend(touched);
    result.links = Some(links);
    result.links_skipped = skipped;
    (result, committed)
}

/// Refresh Codeg's copies of `name` after its content changed (the engine's
/// `refresh_copies`: a copy changed on the agent's side is never replaced).
fn refresh_copies(ctx: &SkillsCtx, name: &str) -> (CopiesRefresh, Vec<AgentType>) {
    let world = World::load(ctx);
    let mut stale = Vec::new();
    let mut kept_changed = Vec::new();
    for entry in world.record.entries() {
        if entry.mode != crate::skills::link::LinkMode::Copy || entry.skill != name {
            continue;
        }
        let path = PathBuf::from(&entry.path);
        match world.entry(&path) {
            Entry::CodegCopy {
                matches: true,
                current: false,
                ..
            } => stale.push(path),
            Entry::CodegCopy { matches: false, .. } => {
                kept_changed.push(path.to_string_lossy().into_owned())
            }
            _ => {}
        }
    }
    drop(world);
    let problems = if stale.is_empty() {
        Vec::new()
    } else {
        crate::skills::packs::refresh_copies(ctx, name)
    };
    let world = World::load(ctx);
    let refreshed: Vec<PathBuf> = stale
        .into_iter()
        .filter(|path| matches!(world.entry(path), Entry::CodegCopy { current: true, .. }))
        .collect();
    let touched = refreshed
        .iter()
        .flat_map(|path| ctx.readers_of_entry(path))
        .collect();
    (
        CopiesRefresh {
            refreshed: refreshed
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
            kept_changed,
            problems,
        },
        touched,
    )
}

/// Link `name` to `agents` through the engine: one request of the ops the
/// preflight does not find blocked (so one agent's folder of the same name
/// does not stop the others), each with its confirmed `ack`. Caller holds
/// the skills lock.
fn link(
    ctx: &SkillsCtx,
    name: &str,
    agents: &[AgentType],
    acks: &BTreeMap<AgentType, String>,
) -> (SkillsApplyResult, Vec<SkillOpResult>, Vec<AgentType>) {
    let ops = enable_ops(name, agents, acks);
    let preflight = apply_blocking(
        ctx,
        &SkillsApplyRequest {
            ops: ops.clone(),
            preflight: true,
        },
    )
    .0;
    let mut skipped = Vec::new();
    let mut runnable = Vec::new();
    for (op, planned) in ops.into_iter().zip(preflight.ops) {
        if planned.status == OpStatus::Blocked {
            skipped.push(planned);
        } else {
            runnable.push(op);
        }
    }
    let (result, changed) = apply_blocking(
        ctx,
        &SkillsApplyRequest {
            ops: runnable,
            preflight: false,
        },
    );
    (result, skipped, changed.agents(ctx))
}

// ─── harness_skill_uninstall ────────────────────────────────────────────

impl HarnessSkillUninstallResult {
    fn new(outcome: UninstallOutcome, item_id: &str) -> Self {
        Self {
            outcome,
            issues: Vec::new(),
            item_id: item_id.to_string(),
            name: None,
            removes: Vec::new(),
            loses: Vec::new(),
            kept_copies: Vec::new(),
            files: FileChanges::default(),
            files_unreadable: None,
            keeps_folder: false,
            backup: None,
            ack: None,
            phases: Vec::new(),
            kept: Vec::new(),
        }
    }
}

/// What an uninstall would do now.
struct RemovalPlan {
    name: String,
    entry: ManifestEntry,
    removes: Vec<model::Removal>,
    loses: Vec<AgentType>,
    kept_copies: Vec<SkillsIssue>,
    files: FileChanges,
    files_unreadable: Option<String>,
    keep_old: bool,
    ack: String,
}

fn plan_removal(ctx: &SkillsCtx, item_id: &str) -> Result<RemovalPlan, Vec<Reason>> {
    let manifest = manifest::load_for_write(&ctx.store).map_err(|e| vec![manifest_reason(&e)])?;
    let Some((name, entry)) = manifest.find_item(item_id) else {
        return Err(vec![
            Reason::new(shared::NOT_INSTALLED).param("item_id", item_id.to_string())
        ]);
    };
    let (name, entry) = (name.clone(), entry.clone());
    let world = World::load(ctx);
    let mut removes = Vec::new();
    let mut kept_copies = Vec::new();
    for dir in ctx.all_dirs() {
        let path = dir.join(&name);
        let readers = ctx
            .dir_info(&dir)
            .map(|info| info.readers.clone())
            .unwrap_or_default();
        let kind = match world.entry(&path) {
            Entry::CodegLink { skill, broken, .. } if skill == name => Some(if broken {
                ChangeKind::BrokenLink
            } else {
                ChangeKind::Link
            }),
            Entry::CodegCopy {
                skill,
                matches: true,
                ..
            } if skill == name => Some(ChangeKind::Copy),
            Entry::CodegCopy {
                skill,
                matches: false,
                ..
            } if skill == name => {
                kept_copies.push(
                    SkillsIssue::new(skill_codes::COPY_MODIFIED_KEPT)
                        .path(&path)
                        .agents(readers.clone()),
                );
                None
            }
            _ => None,
        };
        if let Some(kind) = kind {
            removes.push(model::Removal {
                path: path.to_string_lossy().into_owned(),
                kind,
                agents: readers,
            });
        }
    }
    let loses: Vec<AgentType> = world
        .seen_by(&name)
        .into_iter()
        .filter(|agent| {
            !world
                .entries_of(*agent, &name)
                .iter()
                .any(|(_, _, _, entry)| matches!(entry, Entry::CodegCopy { matches: false, .. }))
        })
        .collect();
    // A folder that cannot be compared is kept whole, never taken for
    // unchanged: one unreadable file must not make every edit deletable.
    let (files, files_unreadable) = match file_changes(&ctx.skill_path(&name), &entry) {
        Ok(files) => (files, None),
        Err(error) => (FileChanges::default(), Some(error.to_string())),
    };
    let keep_old =
        files_unreadable.is_some() || !files.changed.is_empty() || !files.added.is_empty();
    let mut lines: Vec<String> = removes
        .iter()
        .map(|removal| format!("remove {:?} {}", removal.kind, removal.path))
        .collect();
    lines.extend(
        kept_copies
            .iter()
            .map(|kept| format!("keep {}", kept.path.clone().unwrap_or_default())),
    );
    lines.sort();
    lines.push(format!(
        "loses {}",
        loses
            .iter()
            .map(|a| wire_agent(*a))
            .collect::<Vec<_>>()
            .join(",")
    ));
    lines.push(format!("unreadable {}", files_unreadable.is_some()));
    lines.push(format!("backup {keep_old}"));
    let ack = sha256_hex(
        format!(
            "harness-skill-uninstall/1\n{item_id}\n{name}\n{}",
            lines.join("\n")
        )
        .as_bytes(),
    );
    Ok(RemovalPlan {
        name,
        entry,
        removes,
        loses,
        kept_copies,
        files,
        files_unreadable,
        keep_old,
        ack,
    })
}

fn removal_result(
    outcome: UninstallOutcome,
    item_id: &str,
    removal: &RemovalPlan,
) -> HarnessSkillUninstallResult {
    HarnessSkillUninstallResult {
        name: Some(removal.name.clone()),
        removes: removal.removes.clone(),
        loses: removal.loses.clone(),
        kept_copies: removal.kept_copies.clone(),
        files: removal.files.clone(),
        files_unreadable: removal.files_unreadable.clone(),
        keeps_folder: removal.keep_old,
        ack: Some(removal.ack.clone()),
        ..HarnessSkillUninstallResult::new(outcome, item_id)
    }
}

/// Take an installed item out: `preflight` first (what would happen, and
/// the `ack`), then for real with that `ack`.
pub(crate) async fn uninstall(
    local: &Local,
    emitter: &EventEmitter,
    request: HarnessSkillUninstallRequest,
) -> Result<HarnessSkillUninstallResult, AppCommandError> {
    let item_id = request.item_id.trim().to_string();
    if request.preflight {
        let ctx = local.ctx.clone();
        let task_id = item_id.clone();
        return off_thread(move || match plan_removal(&ctx, &task_id) {
            Ok(removal) => removal_result(UninstallOutcome::Preflight, &task_id, &removal),
            Err(issues) => HarnessSkillUninstallResult {
                issues,
                ..HarnessSkillUninstallResult::new(UninstallOutcome::Refused, &task_id)
            },
        })
        .await;
    }
    let guard = match local.ctx.lock().await {
        Ok(guard) => guard,
        Err(error) => {
            return Ok(HarnessSkillUninstallResult {
                issues: vec![Reason::new(error.code()).detail(error.to_string())],
                ..HarnessSkillUninstallResult::new(UninstallOutcome::Busy, &item_id)
            })
        }
    };
    let ctx = local.ctx.clone();
    let task_id = item_id.clone();
    let ack = request.ack.clone();
    let (result, committed) = off_thread(move || {
        let _guard = guard;
        commit_uninstall(&ctx, &task_id, ack)
    })
    .await?;
    if committed.store || !committed.touched.is_empty() {
        let mut kinds = vec![ChangedKind::Store];
        if !committed.touched.is_empty() {
            kinds.push(ChangedKind::Links);
        }
        if committed.backup {
            kinds.push(ChangedKind::Backups);
        }
        let mut agents = result.loses.clone();
        agents.extend(committed.touched.iter().copied());
        crate::skills::announce(emitter, kinds, agents.clone());
        if committed.item_changed {
            agents.sort();
            agents.dedup();
            emit_event(
                emitter,
                INSTALLED_CHANGED_EVENT,
                SkillsInstalledChanged {
                    item_ids: vec![item_id.clone()],
                    agents,
                },
            );
            crate::harness::updates::records_changed();
        }
    }
    Ok(result)
}

fn commit_uninstall(
    ctx: &SkillsCtx,
    item_id: &str,
    ack: Option<String>,
) -> (HarnessSkillUninstallResult, Committed) {
    let mut committed = Committed::default();
    let removal = match plan_removal(ctx, item_id) {
        Ok(removal) => removal,
        Err(issues) => {
            return (
                HarnessSkillUninstallResult {
                    issues,
                    ..HarnessSkillUninstallResult::new(UninstallOutcome::Refused, item_id)
                },
                committed,
            )
        }
    };
    let name = removal.name.clone();
    if ack.as_deref() != Some(removal.ack.as_str()) {
        let code = if ack.is_some() {
            codes::EFFECTS_CHANGED
        } else {
            codes::ACKNOWLEDGEMENT_REQUIRED
        };
        let mut result =
            removal_result(UninstallOutcome::AcknowledgementRequired, item_id, &removal);
        result.issues.push(Reason::new(code));
        return (result, committed);
    }
    let mut result = removal_result(UninstallOutcome::Uninstalled, item_id, &removal);
    result.ack = None;
    let live = ctx.skill_path(&name);
    let journal = new_journal(
        Action::Uninstall,
        &name,
        item_id,
        Some(removal.entry.clone()),
        None,
        fs::symlink_metadata(&live).is_ok(),
        removal.keep_old,
    );
    let failed = |mut result: HarnessSkillUninstallResult, failed: Phase, issue: Reason| {
        result.outcome = UninstallOutcome::WriteFailed;
        result.issues.push(issue);
        result.phases.push(phase(failed, PhaseStatus::Failed));
        result
    };
    let tx = match Tx::begin(ctx, journal) {
        Ok(tx) => tx,
        Err(error) => {
            return (
                failed(result, Phase::Stage, io_issue(codes::IO_ERROR, &error)),
                committed,
            )
        }
    };
    if let Err(error) = tx.write_journal() {
        tx.discard();
        return (
            failed(result, Phase::Stage, io_issue(codes::IO_ERROR, &error)),
            committed,
        );
    }
    // Every agent's link first: a link that cannot go stops the uninstall
    // before the folder does (it would be left pointing at nothing).
    let (touched, problems) = crate::skills::packs::unlink_everywhere(ctx, &name);
    committed.touched.extend(touched);
    let hard: Vec<Reason> = problems
        .iter()
        .filter(|problem| problem.code != skill_codes::COPY_MODIFIED_KEPT)
        .map(|problem| {
            let mut reason = Reason::new(codes::UNLINK_FAILED).param("code", problem.code.clone());
            if let Some(path) = &problem.path {
                reason = reason.param("path", path.clone());
            }
            if let Some(detail) = &problem.detail {
                reason = reason.detail(detail.clone());
            }
            reason
        })
        .collect();
    if !hard.is_empty() {
        result.outcome = UninstallOutcome::WriteFailed;
        result.issues.extend(hard);
        result
            .phases
            .push(phase(Phase::Unlink, PhaseStatus::Failed));
        if let Err(failure) = tx.rollback() {
            result.kept = failure
                .kept
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect();
        }
        return (result, committed);
    }
    result.phases.push(phase(
        Phase::Unlink,
        if removal.removes.is_empty() {
            PhaseStatus::Skipped
        } else {
            PhaseStatus::Done
        },
    ));
    let undo = |mut result: HarnessSkillUninstallResult, at: Phase, issue: Reason| {
        result = failed(result, at, issue);
        if let Err(failure) = tx.rollback() {
            result.kept = failure
                .kept
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect();
            result
                .issues
                .push(Reason::new(codes::ROLLBACK_FAILED).detail(failure.error.to_string()));
        }
        result
    };
    if let Err(error) = tx.swap() {
        let issue = io_issue(codes::IO_ERROR, &error);
        return (undo(result, Phase::Swap, issue), committed);
    }
    result.phases.push(phase(Phase::Swap, PhaseStatus::Done));
    if let Err(error) = tx.commit() {
        let issue = io_issue(codes::MANIFEST_WRITE_FAILED, &error);
        return (undo(result, Phase::Commit, issue), committed);
    }
    result.phases.push(phase(Phase::Commit, PhaseStatus::Done));
    committed.store = true;
    committed.item_changed = true;
    match tx.finish() {
        Ok(kept) => {
            result.phases.push(phase(Phase::Cleanup, PhaseStatus::Done));
            if let Some(path) = kept {
                committed.backup = true;
                result.phases.push(phase(Phase::Backup, PhaseStatus::Done));
                result.backup = Some(path.to_string_lossy().into_owned());
            }
        }
        Err(error) => {
            result.phases.push(phase_detail(
                Phase::Cleanup,
                PhaseStatus::Failed,
                error.to_string(),
            ));
            result.kept.push(tx.dir.to_string_lossy().into_owned());
        }
    }
    (result, committed)
}
