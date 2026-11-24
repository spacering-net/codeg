//! Installing a Harness plugin, and taking it out again (docs/harness-
//! plugins.md §7 「安装对话框」 on the website).
//!
//! 1. **Plan** ([`plan`]): the latest revision and — when it is another —
//!    the one to install whole (`full`, from the fresh `/resolve` snapshot:
//!    the only source a decision is made on), each with its install info and
//!    snapshot; one row per agent: what its host's adapter found
//!    (`detect`), which modes are offered (as a plugin, its skills only,
//!    not at all) and the default, the Experts pack's links the install
//!    would take over, and — skills only — the links' preflight with its
//!    `ack`s. As a plugin only when the adapter's `detect` says the host may
//!    take it (the server's switch included), there is a `full` revision,
//!    it is approved, brings no unpinned MCP server, and the website lists
//!    the host (OpenCode: and the folder has code to load).
//! 2. **Install** ([`install`]): one revision for every agent — `full` when
//!    any agent has it as a plugin, else the latest; as a plugin only with
//!    `approved`, no unpinned MCP server and, when something runs on its
//!    own, the user's agreement to exactly its `exec_sha256`. The call and
//!    the snapshot are checked, the package downloaded and checked; then,
//!    under the plugins lock: everything checked again, the operation
//!    journaled and the revision staged, the snapshot read once more and
//!    compared by fingerprint, then the agents one by one — skills-only
//!    agents first (the Experts pack's links taken over, then the members
//!    through the skills engine), then the hosts' own plugin systems. A
//!    failure undoes the agents done, in reverse (the journal marked as
//!    being undone first); one that cannot be undone is marked as needing
//!    repair. Then the record, the announcement and the update checker.
//! 3. **Uninstall** ([`uninstall`]): a preflight (what goes from which
//!    skills-only agent, who stops seeing it, the Experts links given back)
//!    with its `ack`; then, under the lock and journaled, every agent in
//!    reverse — the host's own uninstall, or the members' links out of the
//!    agent, then the Experts pack's links back (each only where the user
//!    left its place alone) — and the record. An agent that cannot be done
//!    stays in the record, marked as needing repair.
//!
//! Locks: plugins, then — one at a time inside it — skills (members, the
//! Experts links) or the hosts' own (an adapter's business). The install
//! name is the plugin's own name (`PluginInfo.name`): its members call each
//! other by it, so no other name is ever tried. An item installed already
//! is an update or a change of modes, not an install.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use serde_json::json;
use sha2::{Digest, Sha256};

use crate::app_error::AppCommandError;
use crate::harness::error::HarnessError;
use crate::harness::mcp::model::{codes as shared, PlanItem, Reason, INSTALLED_CHANGED_EVENT};
use crate::harness::mcp::snapshot;
use crate::harness::skills::owned::{
    engine_reason, held_reason, install_owned, plan_owned_in_turn, plan_remove_owned,
    plan_remove_owned_in_turn, read_members, remove_owned, OwnedMember, OwnedOrigin, OwnedPlan,
};
use crate::harness::skills::{
    self as harness_skills, codes as skill_codes, package, Local as SkillsLocal,
    SkillsInstalledChanged, UninstallOutcome,
};
use crate::harness::types::{
    ComponentKind, InstallInfo, Kind, NotFull, PluginInfo, Resolved, VersionState, VersionStatus,
};
use crate::harness::{Harness, ItemRef, Origin};
use crate::models::agent::AgentType;
use crate::skills::model::{ChangedKind, OpStatus, SkillsIssue};
use crate::skills::owned::{
    experts_linked, held_back_by, relink_experts, unlink_experts, ExpertLink, ExpertsChange,
    PluginOwner,
};
use crate::skills::SkillsCtx;
use crate::web::event_bridge::{emit_event, EventEmitter};

use super::ctx::{InstallName, PluginsCtx};
use super::hosts::claude::ClaudeAdapter;
use super::hosts::codex::CodexAdapter;
use super::hosts::opencode::OpenCodeAdapter;
use super::hosts::{self, CliVia, Detect, HostAdapter, HostCx, HostEnv, HostId, HostPlugin};
use super::journal::{Action, Tx};
use super::lock::PluginsGuard;
use super::model::*;
use super::record::{
    self, AutorunEntry, Consent, HostEntry, HostMode, HostState, PluginEntry, RecordComponent,
    RecordFile, RecordSource,
};
use super::switches::AdapterSwitches;

/// The local side: the plugin store, Codeg's skill store and the agents'
/// directories (with which agents are installed here), the hosts'
/// adapters, and each agent's environment. Made per command; a test points
/// all of it at temporary directories, stand-in hosts and environments of
/// its own.
#[derive(Clone)]
pub(crate) struct PluginsLocal {
    pub plugins: PluginsCtx,
    pub skills: SkillsLocal,
    pub adapters: Vec<Arc<dyn HostAdapter>>,
    /// Each agent's launch environment (`HostEnv::agent`).
    pub envs: BTreeMap<AgentType, HostEnv>,
    /// For an agent without one of its own.
    pub default_env: HostEnv,
    /// Agents whose host has an adapter but whose launch environment could
    /// not be read: their host is never reached (with a guessed
    /// environment, it could be another profile's) — as if there were no
    /// adapter, said as `plugin_launch_env_unreadable`.
    pub missing_envs: BTreeSet<AgentType>,
}

impl PluginsLocal {
    /// This machine's store and hosts, with `skills` and the agents'
    /// environments as the caller read them.
    #[cfg_attr(test, allow(dead_code))]
    pub(crate) fn here(skills: SkillsLocal, envs: BTreeMap<AgentType, HostEnv>) -> Self {
        let missing_envs = [AgentType::ClaudeCode, AgentType::Codex, AgentType::OpenCode]
            .into_iter()
            .filter(|agent| HostId::for_agent(*agent).is_some() && !envs.contains_key(agent))
            .collect();
        Self {
            plugins: PluginsCtx::user(),
            skills,
            adapters: vec![
                Arc::new(ClaudeAdapter::new()),
                Arc::new(CodexAdapter::new()),
                Arc::new(OpenCodeAdapter::new()),
            ],
            envs,
            default_env: HostEnv::agent(BTreeMap::new()),
            missing_envs,
        }
    }

    /// The host `agent` runs, and its adapter.
    pub(crate) fn adapter(&self, agent: AgentType) -> Option<(HostId, Arc<dyn HostAdapter>)> {
        if self.missing_envs.contains(&agent) {
            return None;
        }
        let host = HostId::for_agent(agent)?;
        self.adapters
            .iter()
            .find(|adapter| adapter.host() == host)
            .map(|adapter| (host, adapter.clone()))
    }

    /// Why `agent`'s host cannot be reached ([`Self::adapter`] is `None`).
    pub(crate) fn no_adapter(&self, agent: AgentType) -> Reason {
        let code = if self.missing_envs.contains(&agent) {
            codes::ENV_UNREADABLE
        } else {
            codes::NO_ADAPTER
        };
        Reason::new(code).param("agent", wire(agent))
    }

    pub(crate) fn env(&self, agent: AgentType) -> HostEnv {
        self.envs
            .get(&agent)
            .cloned()
            .unwrap_or_else(|| self.default_env.clone())
    }

    pub(super) fn skills_ok(&self, agent: AgentType) -> bool {
        let ctx = &self.skills.ctx;
        ctx.agent(agent).is_some() && ctx.link_dir(agent).is_some()
    }
}

pub(super) async fn off_thread<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, AppCommandError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| AppCommandError::task_execution_failed(format!("Harness plugins: {e}")))
}

/// [`off_thread`] holding the plugins lock until `work` returns — also
/// when the caller gives up on it midway: nobody else writes the store or
/// the record while a step of this operation still runs.
pub(super) async fn locked<T: Send + 'static>(
    held: &Arc<PluginsGuard>,
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, AppCommandError> {
    let held = held.clone();
    off_thread(move || {
        let _held = held;
        work()
    })
    .await
}

pub(super) fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub(super) fn wire(agent: AgentType) -> String {
    agent.as_wire().into_owned()
}

pub(super) fn push_unique(into: &mut Vec<Reason>, reasons: impl IntoIterator<Item = Reason>) {
    for reason in reasons {
        if !into.contains(&reason) {
            into.push(reason);
        }
    }
}

pub(super) fn io_reason(error: &std::io::Error) -> Reason {
    Reason::new(skill_codes::IO_ERROR).detail(error.to_string())
}

pub(super) fn issue_reason(issue: &SkillsIssue) -> Reason {
    engine_reason(issue, "")
}

// ─── One revision ───────────────────────────────────────────────────────

/// A revision's install info and its fresh snapshot.
#[derive(Clone)]
pub(super) struct Rev {
    pub(super) info: InstallInfo,
    pub(super) resolved: Resolved,
}

impl Rev {
    pub(super) fn revision(&self) -> u64 {
        self.info.version.revision
    }

    pub(super) fn plugin(&self) -> Option<&PluginInfo> {
        self.info.plugin.as_ref()
    }

    pub(super) fn state(&self) -> Option<&VersionState> {
        self.resolved.installed.as_ref()
    }

    /// By the snapshot: may it be installed whole.
    pub(super) fn approved(&self) -> bool {
        self.state()
            .and_then(|state| state.plugin.as_ref())
            .is_some_and(|plugin| plugin.approved)
    }

    /// What the user agrees to: the snapshot's, else the install info's.
    pub(super) fn exec(&self) -> Option<String> {
        self.state()
            .and_then(|state| state.plugin.as_ref())
            .and_then(|plugin| plugin.exec_sha256.clone())
            .or_else(|| self.plugin().map(|plugin| plugin.exec_sha256.clone()))
    }
}

/// The skill members' names (assistants are not installed this way).
pub(super) fn skill_names(plugin: Option<&PluginInfo>) -> Vec<String> {
    plugin
        .map(|plugin| {
            plugin
                .components
                .iter()
                .filter(|component| component.kind == ComponentKind::Skill)
                .map(|component| component.name.clone())
                .collect()
        })
        .unwrap_or_default()
}

pub(super) async fn read_rev(
    harness: &Harness,
    item_ref: &ItemRef,
    revision: u64,
) -> Result<Rev, HarnessError> {
    let info = harness.install_info(item_ref, revision).await?;
    let resolved = harness_skills::resolve_one(harness, &info.item.id, revision).await?;
    if let Some(state) = &resolved.installed {
        snapshot::remember(state);
    }
    Ok(Rev { info, resolved })
}

/// Why `rev` cannot be installed at all now. The packages the snapshot
/// lists are the plugin's MCP servers': they matter only to an install
/// whole ([`whole_blocking`]), never to its skills.
pub(super) fn revision_blocking(
    rev: &Rev,
    harness: &Harness,
    limits: &harness_skills::PackageLimits,
) -> Vec<Reason> {
    let mut out = Vec::new();
    if rev.info.item.kind != Kind::Plugin {
        out.push(
            Reason::new(codes::NOT_A_PLUGIN).param("kind", snapshot::wire(&rev.info.item.kind)),
        );
    } else if let Some(plugin) = rev.plugin() {
        if InstallName::parse(&plugin.name).is_none() {
            out.push(Reason::new(codes::INSTALL_NAME_INVALID).param("name", plugin.name.clone()));
        }
    } else {
        out.push(Reason::new(codes::PLUGIN_INFO_MISSING));
    }
    let snapshot_blocking = snapshot::item_blocking_as(
        &rev.resolved,
        rev.revision(),
        Kind::Plugin,
        codes::NOT_A_PLUGIN,
    );
    push_unique(&mut out, snapshot_blocking);
    push_unique(
        &mut out,
        package::check_folder_listing(&rev.info, &harness.origin, limits),
    );
    out
}

/// Why nothing may be installed whole: no `full` revision, or the one
/// there is cannot be installed, is not approved, or brings an unpinned MCP
/// server.
pub(super) fn whole_blocking(
    full: Option<&Rev>,
    not_full: Option<NotFull>,
    harness: &Harness,
    limits: &harness_skills::PackageLimits,
) -> Vec<Reason> {
    let Some(rev) = full else {
        let mut reason = Reason::new(codes::NO_FULL);
        if let Some(not_full) = not_full {
            reason = reason.param("reason", snapshot::wire(&not_full));
        }
        return vec![reason];
    };
    let mut out = revision_blocking(rev, harness, limits);
    if out.is_empty() {
        out.extend(harness_skills::package_reasons(rev.state()).0);
    }
    // `full` is the item's: the full revision's own snapshot must name it
    // too (an answer from another moment does not).
    let named = rev
        .state()
        .and_then(|state| state.plugin.as_ref())
        .and_then(|plugin| plugin.full.as_ref())
        .map(|full| full.revision);
    if named != Some(rev.revision()) {
        out.push(
            Reason::new(codes::REVISION_NOT_TARGET)
                .param("revision", rev.revision().to_string())
                .param("expected", named.map(|r| r.to_string()).unwrap_or_default())
                .param("mode", "native"),
        );
    }
    if !rev.approved() {
        out.push(Reason::new(codes::NOT_APPROVED).param("revision", rev.revision().to_string()));
    }
    if rev
        .resolved
        .advisories
        .iter()
        .any(|advisory| advisory.disables(rev.revision()))
    {
        out.push(Reason::new(codes::ADVISORY_DISABLE));
    }
    if let Some(plugin) = rev
        .plugin()
        .filter(|plugin| !plugin.mcp_unpinned.is_empty())
    {
        out.push(Reason::new(codes::MCP_UNPINNED).param("servers", plugin.mcp_unpinned.join(", ")));
    }
    out
}

/// Why `host` cannot take `full` whole, by what the adapter found and the
/// revision itself.
pub(super) fn native_why_not(
    host: HostId,
    detect: &Detect,
    full: Option<&Rev>,
    whole: &[Reason],
    opencode_entry: bool,
) -> Option<Reason> {
    if !detect.supported {
        return Some(
            detect
                .why_not
                .clone()
                .unwrap_or_else(|| Reason::new(hosts::codes::HOST_NOT_FOUND)),
        );
    }
    if let Some(first) = whole.first() {
        return Some(first.clone());
    }
    let Some(plugin) = full.and_then(Rev::plugin) else {
        return Some(Reason::new(codes::NO_FULL));
    };
    if !host.listed_in(plugin) {
        return Some(Reason::new(hosts::codes::HOST_NOT_LISTED));
    }
    if host == HostId::OpenCode && !opencode_entry {
        return Some(Reason::new(hosts::codes::ENTRY_MISSING));
    }
    None
}

/// Whether the revision has an entry OpenCode loads a plugin folder by —
/// `index.js` at its root, or the file `package.json`'s `main` names — as
/// the adapter looks for it ([`OpenCodeAdapter::installable`]), read off
/// the file list and `package.json` itself (by its hash). The folder is
/// checked again once it is staged.
/// The largest `package.json` the plan reads.
const PACKAGE_JSON_BYTES: u64 = 256 * 1024;

pub(super) async fn opencode_entry(harness: &Harness, raw_origin: &Origin, rev: &Rev) -> bool {
    let listed = |path: &str| rev.info.files.iter().any(|file| file.path == path);
    if listed("index.js") {
        return true;
    }
    let Some(package) = rev
        .info
        .files
        .iter()
        .find(|file| file.path == "package.json" && file.size <= PACKAGE_JSON_BYTES)
    else {
        return false;
    };
    // A hosted package's files are on SpaceRing by their hashes; one
    // without an archive is fetched from its source, as its install does.
    let text = match (&rev.info.archive, &rev.info.source) {
        (Some(_), _) => harness.blob(&package.sha256).await.ok(),
        (None, Some(source)) => {
            match package::fetch_from_source(
                harness,
                raw_origin,
                source,
                std::slice::from_ref(package),
            )
            .await
            {
                Ok(Ok(files)) => files
                    .into_iter()
                    .next()
                    .and_then(|file| String::from_utf8(file.bytes).ok()),
                _ => None,
            }
        }
        (None, None) => None,
    };
    let Some(text) = text else {
        return false;
    };
    let main = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|package| package.get("main")?.as_str().map(str::to_string));
    let Some(main) = main else {
        return false;
    };
    let mut relative = main.as_str();
    while let Some(rest) = relative.strip_prefix("./") {
        relative = rest;
    }
    package::safe_path(relative) && listed(relative)
}

/// `whole`: as the revision to install whole (its MCP servers' packages
/// are said).
pub(super) fn plan_revision(rev: &Rev, blocking: Vec<Reason>, whole: bool) -> PlanRevision {
    let plugin = rev.plugin();
    let state = rev.state();
    let mut warnings = if whole {
        harness_skills::package_reasons(state).1
    } else {
        Vec::new()
    };
    if rev.info.archive.is_none() {
        if let Some(source) = &rev.info.source {
            warnings.push(
                Reason::new(skill_codes::FETCHED_FROM_SOURCE)
                    .param("repository", source.repository.clone())
                    .param("commit", source.commit.clone()),
            );
        }
    }
    PlanRevision {
        revision: rev.revision(),
        version: rev.info.version.version.clone(),
        published_at: rev.info.version.published_at.clone(),
        name: plugin.map(|plugin| plugin.name.clone()),
        state_sha256: state.and_then(|state| state.state_sha256.clone()),
        approved: rev.approved(),
        exec_sha256: rev.exec(),
        mcp_unpinned: plugin.map(|p| p.mcp_unpinned.clone()).unwrap_or_default(),
        members: plugin.map(|p| p.components.clone()).unwrap_or_default(),
        autorun: plugin.map(|p| p.autorun.clone()).unwrap_or_default(),
        autorun_files: plugin.map(|p| p.autorun_files.clone()).unwrap_or_default(),
        hosts: plugin.map(|p| p.hosts.clone()).unwrap_or_default(),
        archive: rev.info.archive.clone(),
        source: rev.info.source.clone(),
        files: rev.info.files.clone(),
        total_bytes: rev.info.files.iter().map(|file| file.size).sum(),
        blocking,
        confirm: snapshot::confirmations(state),
        warnings,
    }
}

pub(super) fn plan_detect(detect: &Detect) -> PlanDetect {
    PlanDetect {
        found: detect.cli.is_some(),
        via: detect.cli.as_ref().map(|cli| {
            match cli.via {
                CliVia::Wrapper => "wrapper",
                CliVia::Native => "native",
            }
            .to_string()
        }),
        version: detect.version.as_ref().map(ToString::to_string),
        supported: detect.supported,
        why_not: detect.why_not.clone(),
    }
}

/// The `ack` of an Experts takeover that reaches other agents (a shared
/// directory): over the links as they are now. `None` when it reaches only
/// `agent`.
pub(super) fn experts_ack(agent: AgentType, links: &[ExpertLink]) -> Option<String> {
    let reaches_others = links
        .iter()
        .any(|link| link.agents.iter().any(|reader| *reader != agent));
    if !reaches_others {
        return None;
    }
    let bytes = serde_json::to_vec(&json!({ "agent": wire(agent), "links": links })).ok()?;
    Some(format!("{:x}", Sha256::digest(bytes)))
}

/// Why the record stops an install of `item_id` under `name`: it cannot be
/// read, the item is installed already, or another item has the name (in
/// any spelling: one folder on a case-blind disk).
fn record_refusal(ctx: &PluginsCtx, name: &str, item_id: &str) -> Option<Reason> {
    let record = match record::load_for_write(ctx) {
        Ok(record) => record,
        Err(error) => {
            return Some(Reason::new(shared::RECORD_UNREADABLE).detail(error.detail()));
        }
    };
    if let Some((key, _)) = record
        .plugins
        .iter()
        .find(|(_, entry)| entry.item_id == item_id)
    {
        return Some(Reason::new(codes::ALREADY_INSTALLED).param("name", key.clone()));
    }
    record
        .plugins
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(key, entry)| {
            Reason::new(codes::INSTALL_NAME_TAKEN)
                .param("name", key.clone())
                .param("ref", entry.item_ref.clone())
        })
}

pub(super) fn installed_view(name: &str, entry: &PluginEntry) -> InstalledPlugin {
    InstalledPlugin {
        name: name.to_string(),
        item_id: entry.item_id.clone(),
        item_ref: entry.item_ref.clone(),
        revision: entry.revision,
        version: entry.version.clone(),
        hosts: entry
            .hosts
            .iter()
            .map(|(agent, host)| {
                (
                    agent.clone(),
                    InstalledHost {
                        mode: host.mode,
                        state: host.state.clone(),
                        host_name: host.host_name.clone(),
                        skills: host.skills.clone(),
                        experts: host.experts.clone(),
                    },
                )
            })
            .collect(),
        consent: entry.consent.as_ref().map(|consent| consent.exec.clone()),
        installed_at: entry.installed_at.clone(),
    }
}

// ─── harness_plugin_plan ────────────────────────────────────────────────

/// What the plan reads of this machine, under the plugins lock.
struct LocalPart {
    installed: Option<InstalledPlugin>,
    record_problem: Option<Reason>,
    rows: BTreeMap<AgentType, (Vec<ExpertLink>, Option<OwnedPlan>)>,
}

fn local_part(
    plugins: &PluginsCtx,
    skills: &SkillsCtx,
    owner: Option<&PluginOwner>,
    name: Option<&str>,
    item_id: &str,
    rows: &[(AgentType, PlanMode)],
    members: &[String],
) -> LocalPart {
    let mut out = LocalPart {
        installed: None,
        record_problem: None,
        rows: BTreeMap::new(),
    };
    match record::load(plugins) {
        Ok(record) => {
            out.installed = record
                .plugins
                .iter()
                .find(|(_, entry)| entry.item_id == item_id)
                .map(|(key, entry)| installed_view(key, entry));
            if out.installed.is_none() {
                out.record_problem = name.and_then(|name| record_refusal(plugins, name, item_id));
            }
        }
        Err(error) => {
            out.record_problem =
                Some(Reason::new(shared::RECORD_UNREADABLE).detail(error.detail()));
        }
    }
    // The skills agents' links as the install makes them: one after the
    // other, in its order.
    let mut skills_agents: Vec<AgentType> = rows
        .iter()
        .filter(|(_, mode)| *mode == PlanMode::Skills)
        .map(|(agent, _)| *agent)
        .collect();
    skills_agents.sort_by_key(|agent| step_order(skills, *agent, HostMode::Skills));
    let mut preflights: BTreeMap<AgentType, OwnedPlan> = match owner {
        Some(owner) => plan_owned_in_turn(skills, owner, &skills_agents, members)
            .into_iter()
            .map(|plan| (plan.agent, plan))
            .collect(),
        None => BTreeMap::new(),
    };
    for (agent, mode) in rows {
        if *mode == PlanMode::None {
            continue;
        }
        let experts = experts_linked(skills, *agent, members);
        out.rows.insert(*agent, (experts, preflights.remove(agent)));
    }
    out
}

/// Everything the install dialog shows, in one answer. `agents`: the rows
/// (default: the agents installed here); `modes`: the modes to preflight
/// (default: each row's default). Fails only when the catalog cannot be
/// asked; everything about the item is in the answer.
pub(crate) async fn plan(
    local: &PluginsLocal,
    harness: &Harness,
    item_ref: &str,
    agents: Option<Vec<AgentType>>,
    modes: Option<BTreeMap<AgentType, PlanMode>>,
) -> Result<HarnessPluginPlan, AppCommandError> {
    harness.ensure_enabled()?;
    let item_ref = ItemRef::parse(item_ref)?;
    // The item's `latest` may come through a cache: `/resolve` (read fresh)
    // has the last word on which revision is the latest.
    let mut latest_revision = harness_skills::latest_revision(harness, &item_ref).await?;
    let mut latest = read_rev(harness, &item_ref, latest_revision).await?;
    if let Some(fresh) = latest
        .resolved
        .latest
        .as_ref()
        .map(|latest| latest.revision)
        .filter(|fresh| *fresh != latest_revision && *fresh > 0)
    {
        latest_revision = fresh;
        latest = read_rev(harness, &item_ref, fresh).await?;
    }
    let full_at = latest
        .state()
        .and_then(|state| state.plugin.as_ref())
        .and_then(|plugin| plugin.full.as_ref())
        .map(|full| full.revision);
    let other_full = match full_at {
        Some(revision) if revision != latest_revision => {
            Some(read_rev(harness, &item_ref, revision).await?)
        }
        _ => None,
    };
    let full = match full_at {
        Some(revision) if revision == latest_revision => Some(&latest),
        Some(_) => other_full.as_ref(),
        None => None,
    };
    let config = harness.config().await?;
    let switches = AdapterSwitches::from_config(&config);
    let limits = package::limits_from_config(&config);
    let not_full = latest.plugin().and_then(|plugin| plugin.not_full);
    let latest_blocking = revision_blocking(&latest, harness, &limits);
    let whole = whole_blocking(full, not_full, harness, &limits);

    // One row per agent asked, else per agent installed here.
    let ctx = &local.skills.ctx;
    let rows: Vec<AgentType> = match agents {
        Some(asked) => {
            let mut out: Vec<AgentType> = Vec::new();
            for agent in asked {
                if !out.contains(&agent) {
                    out.push(agent);
                }
            }
            out
        }
        None => ctx
            .agents
            .iter()
            .map(|agent| agent.agent)
            .filter(|agent| local.skills.installed.get(agent).copied().unwrap_or(false))
            .collect(),
    };
    let modes = modes.unwrap_or_default();
    let mut hosts_plan = Vec::new();
    for agent in &rows {
        let agent = *agent;
        let installed = local.skills.installed.get(&agent).copied();
        let (host_id, detect, why_not) = match local.adapter(agent) {
            Some((host, adapter)) => {
                let detect = adapter.detect(&local.env(agent), &switches).await;
                // Read only for a revision that may be installed whole (its
                // listing within the limits).
                let entry = host == HostId::OpenCode
                    && whole.is_empty()
                    && match full {
                        Some(full) => opencode_entry(harness, &local.skills.raw_origin, full).await,
                        None => false,
                    };
                let why_not = native_why_not(host, &detect, full, &whole, entry);
                (Some(host), Some(detect), why_not)
            }
            None => (
                None,
                None,
                Some(local.no_adapter(agent)),
            ),
        };
        let mut offered = Vec::new();
        if why_not.is_none() {
            offered.push(PlanMode::Native);
        }
        if local.skills_ok(agent) {
            offered.push(PlanMode::Skills);
        }
        offered.push(PlanMode::None);
        let default = if installed == Some(true) {
            offered[0]
        } else {
            PlanMode::None
        };
        let planned = modes
            .get(&agent)
            .copied()
            .filter(|mode| offered.contains(mode))
            .unwrap_or(default);
        hosts_plan.push(PlanHost {
            agent,
            host_id: host_id.map(|host| host.as_str().to_string()),
            installed,
            detect: detect.as_ref().map(plan_detect),
            offered,
            default,
            planned,
            why_not,
            experts_to_take_over: Vec::new(),
            experts_ack: None,
            codex_hooks_need_trust: false,
            skills: None,
        });
    }
    let any_native = hosts_plan.iter().any(|row| row.planned == PlanMode::Native);
    // Native is offered only with a `full` revision.
    let target = match (any_native, full) {
        (true, Some(full)) => full,
        _ => &latest,
    };
    let target_plugin = target.plugin();
    let install_name = target_plugin.map(|plugin| plugin.name.clone());
    let members = skill_names(target_plugin);
    let consent_required = any_native
        && full
            .and_then(Rev::plugin)
            .is_some_and(PluginInfo::runs_on_its_own);
    let codex_hooks = full
        .and_then(Rev::plugin)
        .and_then(|plugin| {
            plugin
                .hosts
                .iter()
                .find(|host| host.host == HostId::Codex.as_str())
        })
        .is_some_and(|host| host.hooks > 0);

    let mut blocking = if any_native {
        whole.clone()
    } else {
        latest_blocking.clone()
    };
    let mut warnings = Vec::new();
    if !hosts_plan.iter().any(|row| row.planned != PlanMode::None) {
        warnings.push(Reason::new(codes::NO_HOSTS));
    }

    // This machine's side, under the plugins lock (the members' preflight
    // is the plugin's own store's).
    let parsed = install_name.as_deref().and_then(InstallName::parse);
    let mut installed = None;
    match local.plugins.lock().await {
        Ok(guard) => {
            let owner = parsed.as_ref().map(|name| PluginOwner::new(&guard, name));
            let row_modes: Vec<(AgentType, PlanMode)> = hosts_plan
                .iter()
                .map(|row| (row.agent, row.planned))
                .collect();
            let plugins = local.plugins.clone();
            let skills = ctx.clone();
            let name = install_name.clone();
            let item_id = latest.info.item.id.clone();
            let task_members = members.clone();
            let part = off_thread(move || {
                let _guard = guard;
                local_part(
                    &plugins,
                    &skills,
                    owner.as_ref(),
                    name.as_deref(),
                    &item_id,
                    &row_modes,
                    &task_members,
                )
            })
            .await?;
            if let Some(installed) = &part.installed {
                blocking.push(
                    Reason::new(codes::ALREADY_INSTALLED).param("name", installed.name.clone()),
                );
            }
            blocking.extend(part.record_problem.clone());
            for row in hosts_plan.iter_mut() {
                if let Some((experts, preflight)) = part.rows.get(&row.agent) {
                    row.experts_ack = experts_ack(row.agent, experts);
                    row.experts_to_take_over = experts.clone();
                    row.skills = preflight.clone();
                }
            }
            installed = part.installed;
        }
        Err(error) => {
            blocking.push(Reason::new(error.code()).detail(error.to_string()));
        }
    }
    for row in hosts_plan.iter_mut() {
        row.codex_hooks_need_trust = row.planned == PlanMode::Native
            && row.host_id.as_deref() == Some(HostId::Codex.as_str())
            && codex_hooks;
    }
    Ok(HarnessPluginPlan {
        item: plan_item(&latest),
        item_status: latest.resolved.status,
        latest: plan_revision(&latest, latest_blocking, false),
        full: full.map(|rev| plan_revision(rev, whole.clone(), true)),
        not_full,
        target: target.revision(),
        install_name,
        members: target_plugin
            .map(|plugin| plugin.components.clone())
            .unwrap_or_default(),
        autorun: full
            .and_then(Rev::plugin)
            .map(|plugin| plugin.autorun.clone())
            .unwrap_or_default(),
        snapshot_latest: latest.state().cloned(),
        snapshot_full: full.and_then(Rev::state).cloned(),
        hosts: hosts_plan,
        consent_required,
        consent_exec: full.and_then(Rev::exec),
        blocking,
        warnings,
        installed,
        limits,
    })
}

pub(super) fn plan_item(rev: &Rev) -> PlanItem {
    PlanItem {
        id: rev.info.item.id.clone(),
        item_ref: rev.info.item.r#ref.clone(),
        kind: rev.info.item.kind,
        title: rev.info.item.title.clone(),
        revision: rev.revision(),
        version: rev.info.version.version.clone(),
        published_at: rev.info.version.published_at.clone(),
    }
}

// ─── harness_plugin_install ─────────────────────────────────────────────

/// What the fresh snapshot stops, if anything: the revision can no longer
/// be installed (or is no longer the one these modes install), its state is
/// not the one confirmed, it is yanked and that was not accepted, or what
/// runs on its own is not what the user agreed to.
pub(super) fn fresh_refusal(
    fresh: &Resolved,
    request: &HarnessPluginInstallRequest,
    native: bool,
    plugin: &PluginInfo,
) -> Option<HarnessPluginInstallResult> {
    let revision = request.revision;
    let mut abort = snapshot::item_blocking_as(fresh, revision, Kind::Plugin, codes::NOT_A_PLUGIN);
    // Its MCP servers' packages: only an install whole starts them.
    if abort.is_empty() && native {
        abort.extend(harness_skills::package_reasons(fresh.installed.as_ref()).0);
    }
    let state = match (abort.is_empty(), fresh.installed.clone()) {
        (true, Some(state)) => state,
        (_, state) => {
            if abort.is_empty() {
                abort.push(
                    Reason::new(shared::REVISION_UNAVAILABLE)
                        .param("revision", revision.to_string()),
                );
            }
            return Some(HarnessPluginInstallResult {
                issues: abort,
                state_sha256: state.as_ref().and_then(|state| state.state_sha256.clone()),
                snapshot: state,
                ..HarnessPluginInstallResult::new(PluginInstallOutcome::Aborted)
            });
        }
    };
    let fresh_sha = state.state_sha256.clone().unwrap_or_default();
    if fresh_sha != request.state_sha256 {
        snapshot::remember(&state);
        let confirmed = snapshot::recall(&request.state_sha256);
        return Some(HarnessPluginInstallResult {
            changes: snapshot::changes(confirmed.as_ref(), &state),
            snapshot: Some(state),
            state_sha256: Some(fresh_sha),
            ..HarnessPluginInstallResult::new(PluginInstallOutcome::StateChanged)
        });
    }
    if state.status == VersionStatus::Yanked && !request.accept_yanked {
        return Some(HarnessPluginInstallResult::refused(vec![Reason::new(
            shared::YANKED_NOT_ACCEPTED,
        )]));
    }
    let aborted = |reason: Reason| {
        Some(HarnessPluginInstallResult {
            issues: vec![reason],
            snapshot: Some(state.clone()),
            state_sha256: Some(fresh_sha.clone()),
            ..HarnessPluginInstallResult::new(PluginInstallOutcome::Aborted)
        })
    };
    let not_target = |expected: Option<u64>, mode: &str| {
        Reason::new(codes::REVISION_NOT_TARGET)
            .param("revision", revision.to_string())
            .param(
                "expected",
                expected.map(|r| r.to_string()).unwrap_or_default(),
            )
            .param("mode", mode)
    };
    if native {
        let standing = state.plugin.clone().unwrap_or_default();
        let full = standing.full.as_ref().map(|full| full.revision);
        if full != Some(revision) {
            return aborted(not_target(full, "native"));
        }
        if !standing.approved {
            return aborted(
                Reason::new(codes::NOT_APPROVED).param("revision", revision.to_string()),
            );
        }
        // An advisory asks for it off: nothing of it runs whole.
        if fresh
            .advisories
            .iter()
            .any(|advisory| advisory.disables(revision))
        {
            return aborted(Reason::new(codes::ADVISORY_DISABLE));
        }
        if plugin.runs_on_its_own()
            && (standing.exec_sha256.is_none()
                || standing.exec_sha256.as_deref() != request.consent_exec.as_deref())
        {
            return Some(HarnessPluginInstallResult::refused(vec![Reason::new(
                codes::CONSENT_STALE,
            )
            .param("expected", standing.exec_sha256.clone().unwrap_or_default())]));
        }
    } else {
        let latest = fresh.latest.as_ref().map(|latest| latest.revision);
        if latest != Some(revision) {
            return aborted(not_target(latest, "skills"));
        }
    }
    None
}

/// The record's entry as the install will leave it, before any agent is
/// done.
fn new_entry(
    info: &InstallInfo,
    plugin: &PluginInfo,
    request: &HarnessPluginInstallRequest,
    hosts: &[(AgentType, HostMode)],
    members: &[String],
    consent: Option<Consent>,
) -> PluginEntry {
    PluginEntry {
        item_id: info.item.id.clone(),
        item_ref: info.item.r#ref.clone(),
        revision: request.revision,
        version: info.version.version.clone(),
        archive_sha256: info.archive.as_ref().map(|archive| archive.sha256.clone()),
        source: if info.archive.is_none() {
            info.source.as_ref().map(RecordSource::from)
        } else {
            None
        },
        files: info.files.iter().map(RecordFile::from).collect(),
        exec_sha256: plugin.exec_sha256.clone(),
        autorun: plugin.autorun.iter().map(AutorunEntry::from).collect(),
        components: plugin
            .components
            .iter()
            .map(RecordComponent::from)
            .collect(),
        state_sha256: request.state_sha256.clone(),
        consent,
        hosts: hosts
            .iter()
            .map(|(agent, mode)| {
                let mut host = HostEntry::new(*mode);
                if *mode == HostMode::Skills {
                    host.skills = members.to_vec();
                }
                (wire(*agent), host)
            })
            .collect(),
        previous_revision: None,
        held_revisions: Vec::new(),
        installed_at: now(),
        op: String::new(),
        extra: Default::default(),
    }
}

/// Under the plugins lock, before anything is written: the record again,
/// the skills agents' links against the `ack`s confirmed, the Experts
/// takeovers (and their `ack`s). Returns each agent's takeover.
fn precheck(
    plugins: &PluginsCtx,
    skills: &SkillsCtx,
    owner: &PluginOwner,
    item_id: &str,
    hosts: &[(AgentType, HostMode)],
    members: &[String],
    request: &HarnessPluginInstallRequest,
) -> Result<BTreeMap<AgentType, Vec<ExpertLink>>, Box<HarnessPluginInstallResult>> {
    if let Some(reason) = record_refusal(plugins, owner.name(), item_id) {
        return Err(Box::new(HarnessPluginInstallResult::refused(vec![reason])));
    }
    let mut takeovers = BTreeMap::new();
    let mut refusals = Vec::new();
    let mut unconfirmed = Vec::new();
    let mut answer = HarnessPluginInstallResult::new(PluginInstallOutcome::Refused);
    // `hosts` is in the install's order: each skills agent's links as they
    // will be when its turn comes.
    let skills_agents: Vec<AgentType> = hosts
        .iter()
        .filter(|(_, mode)| *mode == HostMode::Skills)
        .map(|(agent, _)| *agent)
        .collect();
    let mut preflights: BTreeMap<AgentType, OwnedPlan> =
        plan_owned_in_turn(skills, owner, &skills_agents, members)
            .into_iter()
            .map(|plan| (plan.agent, plan))
            .collect();
    for (agent, mode) in hosts {
        let agent = *agent;
        let takeover = experts_linked(skills, agent, members);
        if let Some(ack) = experts_ack(agent, &takeover) {
            match request.experts_acks.get(&agent) {
                Some(given) if *given == ack => {}
                given => unconfirmed.push(
                    Reason::new(if given.is_some() {
                        skill_codes::EFFECTS_CHANGED
                    } else {
                        skill_codes::ACKNOWLEDGEMENT_REQUIRED
                    })
                    .param("agent", wire(agent))
                    .param("name", "experts"),
                ),
            }
            answer.experts_acks.insert(agent, ack);
        }
        if let Some(preflight) = preflights
            .remove(&agent)
            .filter(|_| *mode == HostMode::Skills)
        {
            refusals.extend(preflight.issues.iter().cloned());
            refusals.extend(preflight.held.iter().map(held_reason));
            for op in &preflight.links.ops {
                if op.status == OpStatus::Blocked {
                    refusals.extend(
                        op.issues
                            .iter()
                            .map(|issue| engine_reason(issue, &op.skill)),
                    );
                }
            }
            let given = request.acks.get(&agent);
            for (member, ack) in preflight.acks() {
                match given.and_then(|acks| acks.get(&member)) {
                    Some(sent) if *sent == ack => {}
                    sent => unconfirmed.push(
                        Reason::new(if sent.is_some() {
                            skill_codes::EFFECTS_CHANGED
                        } else {
                            skill_codes::ACKNOWLEDGEMENT_REQUIRED
                        })
                        .param("agent", wire(agent))
                        .param("name", member),
                    ),
                }
            }
            answer.skills.insert(agent, preflight);
        }
        takeovers.insert(agent, takeover);
    }
    if !refusals.is_empty() {
        answer.issues = refusals;
        return Err(Box::new(answer));
    }
    if !unconfirmed.is_empty() {
        answer.outcome = PluginInstallOutcome::AcknowledgementRequired;
        answer.issues = unconfirmed;
        return Err(Box::new(answer));
    }
    Ok(takeovers)
}

/// What the operation changed of the skills side, for the events.
#[derive(Default)]
pub(super) struct Touched {
    pub(super) agents: BTreeSet<AgentType>,
    pub(super) store: bool,
}

impl Touched {
    pub(super) fn experts(&mut self, change: &ExpertsChange) {
        self.agents.extend(change.touched.iter().copied());
    }
}

/// One agent's step as it went: what to undo.
pub(super) struct Started {
    pub(super) agent: AgentType,
    pub(super) mode: HostMode,
    pub(super) host_name: Option<String>,
    /// The Experts pack's links it took out.
    pub(super) experts: Vec<ExpertLink>,
    /// Its host step began: the agent may have something of the plugin
    /// (an agent with only its Experts links taken has nothing to take out).
    pub(super) installing: bool,
}

/// Everything a step needs of the operation.
pub(super) struct Op<'a> {
    pub(super) local: &'a PluginsLocal,
    pub(super) guard: &'a Arc<PluginsGuard>,
    pub(super) name: &'a InstallName,
    pub(super) owner: &'a PluginOwner,
    pub(super) revision: u64,
    pub(super) plugin: Option<&'a PluginInfo>,
    pub(super) detects: &'a BTreeMap<AgentType, Detect>,
}

impl Op<'_> {
    pub(super) fn host_plugin<'p>(
        &'p self,
        host: HostId,
        host_name: Option<&'p str>,
    ) -> HostPlugin<'p> {
        HostPlugin::new(self.name, self.revision, self.plugin, host).with_host_name(host_name)
    }
}

/// The Experts pack's `links` out of `agent`'s directories (skills lock).
pub(super) async fn take_experts(
    guard: &Arc<PluginsGuard>,
    ctx: &SkillsCtx,
    links: Vec<ExpertLink>,
) -> Result<Result<ExpertsChange, Reason>, AppCommandError> {
    if links.is_empty() {
        return Ok(Ok(ExpertsChange::default()));
    }
    let ctx = ctx.clone();
    locked(guard, move || {
        let held = ctx
            .lock_blocking()
            .map_err(|error| Reason::new(error.code()).detail(error.to_string()))?;
        Ok(unlink_experts(&ctx, &held, &links))
    })
    .await
}

/// …and back in (skills lock).
pub(super) async fn give_experts_back(
    guard: &Arc<PluginsGuard>,
    ctx: &SkillsCtx,
    links: Vec<ExpertLink>,
) -> Result<Result<ExpertsChange, Reason>, AppCommandError> {
    if links.is_empty() {
        return Ok(Ok(ExpertsChange::default()));
    }
    let ctx = ctx.clone();
    locked(guard, move || {
        let held = ctx
            .lock_blocking()
            .map_err(|error| Reason::new(error.code()).detail(error.to_string()))?;
        Ok(relink_experts(&ctx, &held, &links))
    })
    .await
}

/// Give `links` back, into `outcome`. `false` when that failed.
pub(super) async fn experts_back(
    op: &Op<'_>,
    links: &[ExpertLink],
    outcome: &mut HostOutcome,
    touched: &mut Touched,
) -> Result<bool, AppCommandError> {
    match give_experts_back(op.guard, &op.local.skills.ctx, links.to_vec()).await? {
        Ok(change) => {
            touched.experts(&change);
            outcome.experts_back.extend(change.done.iter().cloned());
            outcome.experts_back.extend(change.already.iter().cloned());
            outcome.experts_left.extend(change.changed.iter().cloned());
            outcome
                .issues
                .extend(change.issues.iter().map(issue_reason));
            Ok(change.ok())
        }
        Err(reason) => {
            outcome.issues.push(reason);
            Ok(false)
        }
    }
}

/// The Experts pack's links of one agent taken over: a step of its own,
/// before any agent gets the plugin (so the links' preflight, made with all
/// of them gone, is what each agent's turn finds). `started.experts` gets
/// what is to be given back should this or a later step fail.
pub(super) async fn take_step(
    op: &Op<'_>,
    takeover: Vec<ExpertLink>,
    started: &mut Started,
    outcome: &mut HostOutcome,
    touched: &mut Touched,
) -> Result<bool, AppCommandError> {
    match take_experts(op.guard, &op.local.skills.ctx, takeover.clone()).await? {
        Ok(change) if change.ok() => {
            touched.experts(&change);
            started.experts = change.done.clone();
            outcome.experts_taken = change.done.clone();
            Ok(true)
        }
        Ok(change) => {
            // What a failed takeover left out is not known for sure (its own
            // rollback may have failed too): every link it was to take out is
            // given back — one still in place is simply "already". Not those
            // it found gone already, or changed: the user's doing, left so.
            touched.experts(&change);
            started.experts = takeover
                .into_iter()
                .filter(|link| !change.already.contains(link) && !change.changed.contains(link))
                .collect();
            outcome
                .issues
                .extend(change.issues.iter().map(issue_reason));
            Ok(false)
        }
        Err(reason) => {
            // The skills lock was not had: nothing was taken.
            outcome.issues.push(reason);
            Ok(false)
        }
    }
}

/// One agent's install step. `started` gets what is to be undone should
/// this or a later step fail.
#[allow(clippy::too_many_arguments)]
async fn install_step(
    op: &Op<'_>,
    agent: AgentType,
    mode: HostMode,
    origin: &OwnedOrigin,
    members: &[OwnedMember],
    acks: BTreeMap<String, String>,
    started: &mut Started,
    outcome: &mut HostOutcome,
    touched: &mut Touched,
) -> Result<bool, AppCommandError> {
    let ctx = &op.local.skills.ctx;
    match mode {
        HostMode::Skills => {
            let (task_ctx, owner, origin, members) = (
                ctx.clone(),
                op.owner.clone(),
                origin.clone(),
                members.to_vec(),
            );
            let report = locked(op.guard, move || {
                let held = task_ctx
                    .lock_blocking()
                    .map_err(|error| Reason::new(error.code()).detail(error.to_string()))?;
                Ok::<_, Reason>(install_owned(
                    &task_ctx, &held, &owner, agent, &origin, &members, &acks,
                ))
            })
            .await?;
            match report {
                Ok(report) => {
                    touched.agents.extend(report.touched.iter().copied());
                    touched.store |= report.store_changed;
                    if !report.ok() {
                        outcome.issues.extend(report.issues.iter().cloned());
                        outcome.issues.extend(report.held.iter().map(held_reason));
                        return Ok(false);
                    }
                    Ok(true)
                }
                Err(reason) => {
                    outcome.issues.push(reason);
                    Ok(false)
                }
            }
        }
        HostMode::Native => {
            let Some((host, adapter)) = op.local.adapter(agent) else {
                outcome
                    .issues
                    .push(op.local.no_adapter(agent));
                return Ok(false);
            };
            let env = op.local.env(agent);
            let cx = HostCx {
                ctx: &op.local.plugins,
                env: &env,
                cli: op
                    .detects
                    .get(&agent)
                    .and_then(|detect| detect.cli.as_ref()),
                lock: op.guard,
            };
            match adapter.install(&cx, &op.host_plugin(host, None)).await {
                Ok(host_name) => {
                    started.host_name = Some(host_name.clone());
                    outcome.host_name = Some(host_name);
                    Ok(true)
                }
                Err(reason) => {
                    outcome.issues.push(reason);
                    Ok(false)
                }
            }
        }
    }
}

/// Take what `started` put into its agent out again: the undo of an install
/// step, and an uninstall's step. The Experts links are given back after
/// every agent's turn ([`experts_back`]). `false` when the agent could not
/// be brought back.
async fn remove_step(
    op: &Op<'_>,
    started: &Started,
    acks: Option<BTreeMap<String, String>>,
    outcome: &mut HostOutcome,
    touched: &mut Touched,
) -> Result<bool, AppCommandError> {
    let agent = started.agent;
    let ctx = &op.local.skills.ctx;
    if !started.installing {
        return Ok(true);
    }
    match started.mode {
        HostMode::Skills => {
            let (task_ctx, owner) = (ctx.clone(), op.owner.clone());
            let report = locked(op.guard, move || {
                let held = task_ctx
                    .lock_blocking()
                    .map_err(|error| Reason::new(error.code()).detail(error.to_string()))?;
                // Undoing its own install, the plan's `ack`s are the
                // operation's own (the uninstall passes the confirmed ones).
                let acks =
                    acks.unwrap_or_else(|| plan_remove_owned(&task_ctx, &owner, agent).acks());
                Ok::<_, Reason>(remove_owned(&task_ctx, &held, &owner, agent, &acks))
            })
            .await?;
            match report {
                Ok(report) => {
                    touched.agents.extend(report.touched.iter().copied());
                    touched.store |= report.store_changed;
                    outcome.issues.extend(report.issues.iter().cloned());
                    Ok(report.ok())
                }
                Err(reason) => {
                    outcome.issues.push(reason);
                    Ok(false)
                }
            }
        }
        HostMode::Native => match op.local.adapter(agent) {
            Some((host, adapter)) => {
                let env = op.local.env(agent);
                let detect;
                let cli = match op.detects.get(&agent) {
                    Some(found) => found.cli.as_ref(),
                    None => {
                        // Whatever the server's switch says now: taking a
                        // plugin out is always allowed.
                        detect = adapter.detect(&env, &AdapterSwitches::default()).await;
                        detect.cli.as_ref()
                    }
                };
                let cx = HostCx {
                    ctx: &op.local.plugins,
                    env: &env,
                    cli,
                    lock: op.guard,
                };
                let plugin = op.host_plugin(host, started.host_name.as_deref());
                match adapter.uninstall(&cx, &plugin).await {
                    Ok(()) => Ok(true),
                    Err(reason) => {
                        outcome.issues.push(reason);
                        Ok(false)
                    }
                }
            }
            None => {
                outcome
                    .issues
                    .push(op.local.no_adapter(agent));
                Ok(false)
            }
        },
    }
}

/// Of `left` (Experts links not given back), those that only this plugin's
/// own members, still in an agent, kept from going back
/// (`skills::owned::held_back_by`): the others the user changed.
pub(super) async fn held_back(
    op: &Op<'_>,
    left: Vec<ExpertLink>,
) -> Result<Vec<ExpertLink>, AppCommandError> {
    if left.is_empty() {
        return Ok(left);
    }
    let (ctx, plugin) = (op.local.skills.ctx.clone(), op.name.to_string());
    locked(op.guard, move || {
        left.into_iter()
            .filter(|link| held_back_by(&ctx, link, &plugin))
            .collect()
    })
    .await
}

/// Of `links`, after a give-back that did not go through (`outcome`): those
/// still to try again — not back already, and not left because the user
/// changed their place (only those this plugin's own members held back).
pub(super) async fn still_to_give_back(
    op: &Op<'_>,
    links: &[ExpertLink],
    outcome: &HostOutcome,
) -> Result<Vec<ExpertLink>, AppCommandError> {
    let left: Vec<ExpertLink> = links
        .iter()
        .filter(|link| outcome.experts_left.contains(link))
        .cloned()
        .collect();
    let held = held_back(op, left).await?;
    Ok(links
        .iter()
        .filter(|link| {
            !outcome.experts_back.contains(link)
                && (!outcome.experts_left.contains(link) || held.contains(link))
        })
        .cloned()
        .collect())
}

/// Experts links not given back (`experts_left`) go to the agent the record
/// keeps them under (`keeper`; none: they are dropped): one whose place
/// another agent of the plugin still provides the name in is given back
/// once that agent is done with it (a link the user changed is left alone
/// then too).
pub(super) fn carry_experts(
    hosts: &mut BTreeMap<String, HostEntry>,
    keeper: Option<&String>,
    left: Vec<ExpertLink>,
) {
    let Some(host) = keeper.and_then(|agent| hosts.get_mut(agent)) else {
        return;
    };
    for link in left {
        if !host.experts.contains(&link) {
            host.experts.push(link);
        }
    }
}

/// Undo `started` (in the install's order) after the journal says so —
/// every agent's removal, latest first, then the Experts links back — then
/// roll the operation back, marking the agents that could not be undone.
/// The answer gets each agent's status and `needs_repair`.
async fn undo_all(
    op: &Op<'_>,
    tx: Tx,
    after: &mut PluginEntry,
    started: Vec<Started>,
    answer: &mut HarnessPluginInstallResult,
    touched: &mut Touched,
) -> Result<(), AppCommandError> {
    let mut tx = tx;
    // What each agent has to be given back, as the steps left it: what a
    // rollback marks for repair keeps exactly that.
    let entry = after.clone();
    let (back, marked) = locked(op.guard, move || {
        let marked = tx.undoing().and_then(|()| tx.set_after(Some(entry)));
        (tx, marked)
    })
    .await?;
    tx = back;
    if let Err(error) = marked {
        answer.issues.push(io_reason(&error));
    }
    let mut needs_repair: BTreeSet<String> = BTreeSet::new();
    let mut removed = Vec::new();
    for step in started.iter().rev() {
        let Some(index) = answer
            .hosts
            .iter()
            .position(|host| host.agent == step.agent)
        else {
            continue;
        };
        let mut outcome = answer.hosts[index].clone();
        if remove_step(op, step, None, &mut outcome, touched).await? {
            removed.push((index, step));
        } else {
            needs_repair.insert(wire(step.agent));
            outcome.status = HostStepStatus::NeedsRepair;
        }
        answer.hosts[index] = outcome;
    }
    let mut left = Vec::new();
    for (index, step) in removed {
        let mut outcome = answer.hosts[index].clone();
        if experts_back(op, &step.experts, &mut outcome, touched).await? {
            left.extend(outcome.experts_left.iter().cloned());
            if outcome.status != HostStepStatus::Failed {
                outcome.status = HostStepStatus::Undone;
            }
        } else {
            needs_repair.insert(wire(step.agent));
            outcome.status = HostStepStatus::NeedsRepair;
            let still = still_to_give_back(op, &step.experts, &outcome).await?;
            if let Some(host) = after.hosts.get_mut(&wire(step.agent)) {
                host.experts = still;
            }
        }
        answer.hosts[index] = outcome;
    }
    let left = if needs_repair.is_empty() {
        Vec::new()
    } else {
        held_back(op, left).await?
    };
    if !needs_repair.is_empty() {
        // The agents marked keep, in the record the rollback writes, what is
        // still to be given back.
        carry_experts(&mut after.hosts, needs_repair.iter().next(), left);
        let entry = after.clone();
        let (back, kept) = locked(op.guard, move || {
            let kept = tx.set_after(Some(entry));
            (tx, kept)
        })
        .await?;
        tx = back;
        if let Err(error) = kept {
            answer.issues.push(io_reason(&error));
        }
    }
    let repair = needs_repair.clone();
    let rolled = locked(op.guard, move || tx.rollback(&repair)).await?;
    match rolled {
        Ok(marked) => {
            answer.needs_repair = marked
                .iter()
                .filter_map(|agent| AgentType::from_wire(agent))
                .collect();
        }
        Err(error) => {
            // The journal stays: the next start rolls it back, marking every
            // agent a step touched.
            answer.issues.push(io_reason(&error));
            answer.needs_repair = started.iter().map(|step| step.agent).collect();
        }
    }
    if !answer.needs_repair.is_empty() {
        answer.issues.push(
            Reason::new(codes::NEEDS_REPAIR).param(
                "agents",
                answer
                    .needs_repair
                    .iter()
                    .map(|agent| wire(*agent))
                    .collect::<Vec<_>>()
                    .join(","),
            ),
        );
    }
    answer.outcome = PluginInstallOutcome::Failed;
    Ok(())
}

/// The order an install takes the agents in: skills-only agents first —
/// those whose skills go into a directory other agents read before those
/// with one of their own (an agent that reads the shared one too then sees
/// the members there already: nothing more is linked for it, and nothing
/// the confirmed `ack`s did not cover is planned) — then the hosts' own
/// plugin systems; each in the agents' order. An uninstall goes in reverse.
pub(super) fn step_order(
    ctx: &SkillsCtx,
    agent: AgentType,
    mode: HostMode,
) -> (bool, bool, AgentType) {
    let shared = ctx.link_dir(agent).is_some_and(|(_, shared)| shared);
    (mode == HostMode::Native, !shared, agent)
}

/// Install with what the user confirmed. See the module docs for the
/// order; every way back without writing is in the answer.
pub(crate) async fn install(
    local: &PluginsLocal,
    harness: &Harness,
    emitter: &EventEmitter,
    request: HarnessPluginInstallRequest,
) -> Result<HarnessPluginInstallResult, AppCommandError> {
    harness.ensure_enabled()?;
    let item_ref = ItemRef::parse(&request.item_ref)?;
    if request.revision == 0 {
        return Err(HarnessError::InvalidRef.into());
    }

    // The call itself, before anything is asked. In the order of
    // `step_order`.
    let mut hosts: Vec<(AgentType, HostMode)> = request
        .hosts
        .iter()
        .filter_map(|(agent, mode)| Some((*agent, mode.host_mode()?)))
        .collect();
    hosts.sort_by_key(|(agent, mode)| step_order(&local.skills.ctx, *agent, *mode));
    let native = hosts.iter().any(|(_, mode)| *mode == HostMode::Native);
    let mut issues = Vec::new();
    if hosts.is_empty() {
        issues.push(Reason::new(codes::NO_HOSTS));
    }
    for (agent, mode) in &hosts {
        match mode {
            HostMode::Skills if !local.skills_ok(*agent) => issues
                .push(Reason::new(skill_codes::AGENT_UNSUPPORTED).param("agent", wire(*agent))),
            HostMode::Native if local.adapter(*agent).is_none() => {
                issues.push(local.no_adapter(*agent))
            }
            _ => {}
        }
    }
    let name = InstallName::parse(request.install_name.trim());
    if name.is_none() {
        issues.push(
            Reason::new(codes::INSTALL_NAME_INVALID).param("name", request.install_name.clone()),
        );
    }
    let Some(name) = name.filter(|_| issues.is_empty()) else {
        return Ok(HarnessPluginInstallResult::refused(issues));
    };

    // What never changes about the revision.
    let info = harness.install_info(&item_ref, request.revision).await?;
    if info.item.kind != Kind::Plugin {
        return Ok(HarnessPluginInstallResult::refused(vec![Reason::new(
            codes::NOT_A_PLUGIN,
        )
        .param("kind", snapshot::wire(&info.item.kind))]));
    }
    let Some(plugin) = info.plugin.clone() else {
        return Ok(HarnessPluginInstallResult::refused(vec![Reason::new(
            codes::PLUGIN_INFO_MISSING,
        )]));
    };
    if plugin.name != name.as_str() {
        return Ok(HarnessPluginInstallResult::refused(vec![Reason::new(
            codes::INSTALL_NAME_MISMATCH,
        )
        .param("expected", plugin.name.clone())
        .param("name", name.as_str())]));
    }
    let task_ctx = local.plugins.clone();
    let (task_name, task_id) = (name.as_str().to_string(), info.item.id.clone());
    if let Some(reason) =
        off_thread(move || record_refusal(&task_ctx, &task_name, &task_id)).await?
    {
        return Ok(HarnessPluginInstallResult::refused(vec![reason]));
    }
    let config = harness.config().await?;
    let switches = AdapterSwitches::from_config(&config);
    let limits = package::limits_from_config(&config);
    let listing = package::check_folder_listing(&info, &harness.origin, &limits);
    if !listing.is_empty() {
        return Ok(HarnessPluginInstallResult {
            issues: listing,
            name: Some(name.to_string()),
            ..HarnessPluginInstallResult::new(PluginInstallOutcome::InvalidPackage)
        });
    }

    // Whole: only what may be, with the user's agreement to what runs.
    let autorun = native && plugin.runs_on_its_own();
    if native {
        if !plugin.mcp_unpinned.is_empty() {
            issues.push(
                Reason::new(codes::MCP_UNPINNED).param("servers", plugin.mcp_unpinned.join(", ")),
            );
        }
        if autorun {
            match &request.consent_exec {
                None => issues.push(Reason::new(codes::CONSENT_REQUIRED)),
                Some(given) if *given != plugin.exec_sha256 => issues.push(
                    Reason::new(codes::CONSENT_STALE).param("expected", plugin.exec_sha256.clone()),
                ),
                Some(_) => {}
            }
        }
    }
    let mut detects: BTreeMap<AgentType, Detect> = BTreeMap::new();
    for (agent, mode) in &hosts {
        if *mode != HostMode::Native {
            continue;
        }
        let Some((host, adapter)) = local.adapter(*agent) else {
            continue;
        };
        let detect = adapter.detect(&local.env(*agent), &switches).await;
        let why = if !detect.supported {
            detect
                .why_not
                .clone()
                .or_else(|| Some(Reason::new(hosts::codes::HOST_NOT_FOUND)))
        } else if !host.listed_in(&plugin) {
            Some(Reason::new(hosts::codes::HOST_NOT_LISTED))
        } else {
            None
        };
        if let Some(why) = why {
            let mut reason = Reason::new(codes::NATIVE_UNAVAILABLE)
                .param("agent", wire(*agent))
                .param("why", why.code.clone());
            if let Some(detail) = why.detail {
                reason = reason.detail(detail);
            }
            issues.push(reason);
        }
        detects.insert(*agent, detect);
    }
    if !issues.is_empty() {
        return Ok(HarnessPluginInstallResult::refused(issues));
    }

    // The snapshot, fresh: the revision these modes install, as confirmed.
    let fresh = harness_skills::resolve_one(harness, &info.item.id, request.revision).await?;
    if let Some(stop) = fresh_refusal(&fresh, &request, native, &plugin) {
        return Ok(stop);
    }

    // The package, every byte checked.
    let files = match package::fetch(harness, &local.skills.raw_origin, &info, &limits).await? {
        Ok(files) => files,
        Err(issues) => {
            return Ok(HarnessPluginInstallResult {
                issues,
                name: Some(name.to_string()),
                ..HarnessPluginInstallResult::new(PluginInstallOutcome::InvalidPackage)
            })
        }
    };

    // Under the plugins lock from here on.
    let guard = match local.plugins.lock().await {
        Ok(guard) => guard,
        Err(error) => {
            return Ok(HarnessPluginInstallResult {
                issues: vec![Reason::new(error.code()).detail(error.to_string())],
                name: Some(name.to_string()),
                ..HarnessPluginInstallResult::new(PluginInstallOutcome::Busy)
            })
        }
    };
    let guard = Arc::new(guard);
    let owner = PluginOwner::new(&guard, &name);
    let members = skill_names(Some(&plugin));
    let task = (
        local.plugins.clone(),
        local.skills.ctx.clone(),
        owner.clone(),
        info.item.id.clone(),
        hosts.clone(),
        members.clone(),
        request.clone(),
    );
    let checked = locked(&guard, move || {
        let (plugins, skills, owner, item_id, hosts, members, request) = task;
        precheck(
            &plugins, &skills, &owner, &item_id, &hosts, &members, &request,
        )
    })
    .await?;
    let takeovers = match checked {
        Ok(takeovers) => takeovers,
        Err(answer) => {
            let mut answer = *answer;
            answer.name = Some(name.to_string());
            return Ok(answer);
        }
    };

    // Journaled, then staged.
    let consent = autorun.then(|| Consent {
        exec: request.consent_exec.clone().unwrap_or_default(),
        at: now(),
        extra: Default::default(),
    });
    let mut after = new_entry(&info, &plugin, &request, &hosts, &members, consent);
    let task = (
        local.plugins.clone(),
        name.clone(),
        after.clone(),
        info.files.clone(),
        files,
        request.revision,
    );
    let held = guard.clone();
    let begun = locked(&guard, move || {
        let (ctx, name, after, listing, files, revision) = task;
        Tx::begin(&ctx, &held, Action::Install, &name, Some(after)).map(|mut tx| {
            match tx.stage(revision, &listing, &files) {
                Ok(staged) => Ok((tx, staged)),
                Err(error) => {
                    // Nothing of any agent's touched: the journal and what
                    // was staged go.
                    let _ = tx.rollback(&BTreeSet::new());
                    Err(error)
                }
            }
        })
    })
    .await?;
    let (mut tx, staged) = match begun {
        Ok(Ok(begun)) => begun,
        Ok(Err(error)) | Err(error) => {
            return Ok(HarnessPluginInstallResult {
                issues: vec![io_reason(&error)],
                name: Some(name.to_string()),
                ..HarnessPluginInstallResult::new(PluginInstallOutcome::Failed)
            })
        }
    };

    // The last checks before any agent is touched: the snapshot once more,
    // OpenCode's code in the folder, the members' files.
    let fresh = harness_skills::resolve_one(harness, &info.item.id, request.revision).await;
    let mut stop = match &fresh {
        Ok(fresh) => fresh_refusal(fresh, &request, native, &plugin),
        Err(_) => None,
    };
    if let Err(error) = fresh {
        // The catalog could not be asked: nothing of any agent's touched.
        let undone = locked(&guard, move || tx.rollback(&BTreeSet::new())).await?;
        if let Err(undo) = undone {
            tracing::warn!("[Harness plugins] the staged install could not be cleared: {undo}");
        }
        return Err(error.into());
    }
    if stop.is_none() {
        let opencode: Vec<AgentType> = hosts
            .iter()
            .filter(|(agent, mode)| {
                *mode == HostMode::Native && HostId::for_agent(*agent) == Some(HostId::OpenCode)
            })
            .map(|(agent, _)| *agent)
            .collect();
        if !opencode.is_empty() {
            if let Err(why) = OpenCodeAdapter::installable(&plugin, &staged.path) {
                stop = Some(HarnessPluginInstallResult::refused(
                    opencode
                        .iter()
                        .map(|agent| {
                            Reason::new(codes::NATIVE_UNAVAILABLE)
                                .param("agent", wire(*agent))
                                .param("why", why.code.clone())
                        })
                        .collect(),
                ));
            }
        }
    }
    let mut owned_members = Vec::new();
    if stop.is_none() && hosts.iter().any(|(_, mode)| *mode == HostMode::Skills) {
        let (dir, components, listing) = (
            staged.path.clone(),
            plugin.components.clone(),
            info.files.clone(),
        );
        match locked(&guard, move || read_members(&dir, &components, &listing)).await? {
            Ok(read) => owned_members = read,
            Err(issues) => {
                stop = Some(HarnessPluginInstallResult {
                    issues,
                    ..HarnessPluginInstallResult::new(PluginInstallOutcome::InvalidPackage)
                })
            }
        }
    }
    if let Some(mut stop) = stop {
        // No agent touched: only the journal and the staging go.
        let undone = locked(&guard, move || tx.rollback(&BTreeSet::new())).await?;
        if let Err(error) = undone {
            stop.issues.push(io_reason(&error));
        }
        stop.name = Some(name.to_string());
        return Ok(stop);
    }

    // The agents, one by one.
    let origin = OwnedOrigin {
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
        state_sha256: request.state_sha256.clone(),
    };
    let op = Op {
        local,
        guard: &guard,
        name: &name,
        owner: &owner,
        revision: request.revision,
        plugin: Some(&plugin),
        detects: &detects,
    };
    let mut answer = HarnessPluginInstallResult::new(PluginInstallOutcome::Installed);
    answer.name = Some(name.to_string());
    answer.revision = Some(request.revision);
    let mut touched = Touched::default();
    // One per agent begun, in the install's order; `answer.hosts` alike.
    let mut started: Vec<Started> = Vec::new();
    let mut failed = false;
    // The Experts pack's links first, for every agent: each written down
    // before anything moves, so a crash midway gives them back.
    for (agent, mode) in &hosts {
        let (agent, mode) = (*agent, *mode);
        let takeover = takeovers.get(&agent).cloned().unwrap_or_default();
        if takeover.is_empty() {
            continue;
        }
        let agent_wire = wire(agent);
        if let Some(host) = after.hosts.get_mut(&agent_wire) {
            host.experts = takeover.clone();
        }
        let (entry, step_wire) = (after.clone(), agent_wire.clone());
        let (back, planned) = locked(&guard, move || {
            let planned = tx
                .set_after(Some(entry))
                .and_then(|()| tx.step_planned(&step_wire, mode, "take_over"));
            (tx, planned)
        })
        .await?;
        tx = back;
        let index = match planned {
            Ok(index) => index,
            Err(error) => {
                answer.issues.push(io_reason(&error));
                failed = true;
                break;
            }
        };
        let mut outcome = HostOutcome::new(agent, mode);
        let mut step = Started {
            agent,
            mode,
            host_name: None,
            experts: Vec::new(),
            installing: false,
        };
        let ok = take_step(&op, takeover, &mut step, &mut outcome, &mut touched).await?;
        if let Some(host) = after.hosts.get_mut(&agent_wire) {
            host.experts = step.experts.clone();
        }
        if !ok {
            outcome.status = HostStepStatus::Failed;
        }
        answer.hosts.push(outcome);
        started.push(step);
        if !ok {
            answer.issues.push(
                Reason::new(codes::HOST_STEP_FAILED)
                    .param("agent", agent_wire)
                    .param("step", "take_over"),
            );
            failed = true;
            break;
        }
        let entry = after.clone();
        let (back, done) = locked(&guard, move || {
            let done = tx.set_after(Some(entry)).and_then(|()| tx.step_done(index));
            (tx, done)
        })
        .await?;
        tx = back;
        if let Err(error) = done {
            answer.issues.push(io_reason(&error));
            failed = true;
            break;
        }
    }
    // Then the agents, one by one.
    for (agent, mode) in &hosts {
        if failed {
            break;
        }
        let (agent, mode) = (*agent, *mode);
        let agent_wire = wire(agent);
        let step_wire = agent_wire.clone();
        let (back, planned) = locked(&guard, move || {
            let planned = tx.step_planned(&step_wire, mode, "install");
            (tx, planned)
        })
        .await?;
        tx = back;
        let index = match planned {
            Ok(index) => index,
            Err(error) => {
                answer.issues.push(io_reason(&error));
                failed = true;
                break;
            }
        };
        let at = match started.iter().position(|step| step.agent == agent) {
            Some(at) => at,
            None => {
                started.push(Started {
                    agent,
                    mode,
                    host_name: None,
                    experts: Vec::new(),
                    installing: false,
                });
                answer.hosts.push(HostOutcome::new(agent, mode));
                started.len() - 1
            }
        };
        started[at].installing = true;
        let acks = request.acks.get(&agent).cloned().unwrap_or_default();
        let ok = install_step(
            &op,
            agent,
            mode,
            &origin,
            &owned_members,
            acks,
            &mut started[at],
            &mut answer.hosts[at],
            &mut touched,
        )
        .await?;
        if let Some(host) = after.hosts.get_mut(&agent_wire) {
            host.host_name = started[at].host_name.clone();
        }
        if !ok {
            answer.hosts[at].status = HostStepStatus::Failed;
            answer.issues.push(
                Reason::new(codes::HOST_STEP_FAILED)
                    .param("agent", agent_wire)
                    .param("step", "install"),
            );
            failed = true;
            break;
        }
        let entry = after.clone();
        let (back, done) = locked(&guard, move || {
            let done = tx.set_after(Some(entry)).and_then(|()| tx.step_done(index));
            (tx, done)
        })
        .await?;
        tx = back;
        if let Err(error) = done {
            answer.issues.push(io_reason(&error));
            failed = true;
            break;
        }
    }

    if !failed {
        let entry = after.clone();
        let (back, committed) = locked(&guard, move || {
            let committed = tx.set_after(Some(entry)).and_then(|()| tx.commit());
            (tx, committed)
        })
        .await?;
        tx = back;
        match committed {
            Ok(()) => {
                match locked(&guard, move || tx.finish()).await? {
                    Ok(problems) => answer.problems = problems,
                    Err(error) => answer.problems.push(error.to_string()),
                }
                drop(guard);
                announce(
                    emitter,
                    &info.item.id,
                    hosts.iter().map(|(agent, _)| *agent),
                    &touched,
                    true,
                );
                return Ok(answer);
            }
            Err(error) => {
                answer.issues.push(io_reason(&error));
            }
        }
    }
    undo_all(&op, tx, &mut after, started, &mut answer, &mut touched).await?;
    let marked = !answer.needs_repair.is_empty();
    drop(guard);
    announce(
        emitter,
        &info.item.id,
        answer.needs_repair.iter().copied(),
        &touched,
        marked,
    );
    Ok(answer)
}

/// Tell every window what changed: the skills side (store, links), and —
/// when the record changed — the installed items, then the update checker.
pub(super) fn announce(
    emitter: &EventEmitter,
    item_id: &str,
    agents: impl IntoIterator<Item = AgentType>,
    touched: &Touched,
    record_changed: bool,
) {
    let mut kinds = Vec::new();
    if touched.store {
        kinds.push(ChangedKind::Store);
    }
    if !touched.agents.is_empty() {
        kinds.push(ChangedKind::Links);
    }
    crate::skills::announce(emitter, kinds, touched.agents.iter().copied());
    if record_changed {
        let mut agents: Vec<AgentType> = agents.into_iter().collect();
        agents.extend(touched.agents.iter().copied());
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

// ─── harness_plugin_uninstall ───────────────────────────────────────────

/// What an uninstall will do, read under the plugins lock.
struct UninstallPlan {
    name: InstallName,
    entry: PluginEntry,
    /// The agents in the order they are done: the reverse of the install's.
    order: Vec<(AgentType, HostEntry)>,
    removes: BTreeMap<AgentType, OwnedPlan>,
    ack: Option<String>,
    issues: Vec<Reason>,
}

fn uninstall_plan(
    plugins: &PluginsCtx,
    skills: &SkillsCtx,
    guard: &PluginsGuard,
    item_id: &str,
) -> Result<UninstallPlan, Vec<Reason>> {
    let record = record::load_for_write(plugins)
        .map_err(|error| vec![Reason::new(shared::RECORD_UNREADABLE).detail(error.detail())])?;
    let Some((key, entry)) = record
        .plugins
        .iter()
        .find(|(_, entry)| entry.item_id == item_id)
    else {
        return Err(vec![Reason::new(shared::NOT_INSTALLED)]);
    };
    let name = InstallName::parse(key)
        .ok_or_else(|| vec![Reason::new(codes::INSTALL_NAME_INVALID).param("name", key.clone())])?;
    let owner = PluginOwner::new(guard, &name);
    let mut issues = Vec::new();
    let mut order = Vec::new();
    for (agent_wire, host) in &entry.hosts {
        match AgentType::from_wire(agent_wire) {
            Some(agent) => order.push((agent, host.clone())),
            None => issues.push(
                Reason::new(skill_codes::AGENT_UNSUPPORTED).param("agent", agent_wire.clone()),
            ),
        }
    }
    // The reverse of the install's order.
    order.sort_by_key(|(agent, host)| step_order(skills, *agent, host.mode));
    order.reverse();
    let skills_agents: Vec<AgentType> = order
        .iter()
        .filter(|(_, host)| host.mode == HostMode::Skills)
        .map(|(agent, _)| *agent)
        .collect();
    let mut removes = BTreeMap::new();
    for preflight in plan_remove_owned_in_turn(skills, &owner, &skills_agents) {
        issues.extend(preflight.issues.iter().cloned());
        removes.insert(preflight.agent, preflight);
    }
    let acks: BTreeMap<String, BTreeMap<String, String>> = removes
        .iter()
        .map(|(agent, preflight)| (wire(*agent), preflight.acks()))
        .filter(|(_, acks)| !acks.is_empty())
        .collect();
    let ack = (!acks.is_empty())
        .then(|| serde_json::to_vec(&json!({ "op": entry.op, "acks": acks })).ok())
        .flatten()
        .map(|bytes| format!("{:x}", Sha256::digest(bytes)));
    Ok(UninstallPlan {
        name,
        entry: entry.clone(),
        order,
        removes,
        ack,
        issues,
    })
}

/// Take the plugin out of every agent, then out of the record (see the
/// module docs). Touches only this machine.
pub(crate) async fn uninstall(
    local: &PluginsLocal,
    emitter: &EventEmitter,
    request: HarnessPluginUninstallRequest,
) -> Result<HarnessPluginUninstallResult, AppCommandError> {
    let item_id = request.item_id.clone();
    let guard = match local.plugins.lock().await {
        Ok(guard) => guard,
        Err(error) => {
            let mut answer = HarnessPluginUninstallResult::new(UninstallOutcome::Busy, &item_id);
            answer.issues = vec![Reason::new(error.code()).detail(error.to_string())];
            return Ok(answer);
        }
    };
    let (plugins, skills, task_id) = (
        local.plugins.clone(),
        local.skills.ctx.clone(),
        item_id.clone(),
    );
    let guard = Arc::new(guard);
    let held = guard.clone();
    let planned = locked(&guard, move || {
        uninstall_plan(&plugins, &skills, &held, &task_id)
    })
    .await?;
    let plan = match planned {
        Ok(plan) => plan,
        Err(issues) => {
            let mut answer = HarnessPluginUninstallResult::new(UninstallOutcome::Refused, &item_id);
            answer.issues = issues;
            return Ok(answer);
        }
    };
    let mut answer = HarnessPluginUninstallResult::new(UninstallOutcome::Preflight, &item_id);
    answer.name = Some(plan.name.to_string());
    answer.removes = plan.removes.clone();
    answer.experts = plan
        .order
        .iter()
        .filter(|(_, host)| !host.experts.is_empty())
        .map(|(agent, host)| (*agent, host.experts.clone()))
        .collect();
    answer.ack = plan.ack.clone();
    if !plan.issues.is_empty() {
        answer.outcome = UninstallOutcome::Refused;
        answer.issues = plan.issues;
        return Ok(answer);
    }
    if request.preflight {
        return Ok(answer);
    }
    if plan.ack.is_some() && request.ack != plan.ack {
        answer.outcome = UninstallOutcome::AcknowledgementRequired;
        answer.issues = vec![Reason::new(if request.ack.is_some() {
            skill_codes::EFFECTS_CHANGED
        } else {
            skill_codes::ACKNOWLEDGEMENT_REQUIRED
        })];
        return Ok(answer);
    }

    let (ctx, name) = (local.plugins.clone(), plan.name.clone());
    let held = guard.clone();
    let begun = locked(&guard, move || {
        Tx::begin(&ctx, &held, Action::Uninstall, &name, None)
    })
    .await?;
    let mut tx = match begun {
        Ok(tx) => tx,
        Err(error) => {
            answer.outcome = UninstallOutcome::WriteFailed;
            answer.issues = vec![io_reason(&error)];
            return Ok(answer);
        }
    };
    let owner = PluginOwner::new(&guard, &plan.name);
    let detects = BTreeMap::new();
    let op = Op {
        local,
        guard: &guard,
        name: &plan.name,
        owner: &owner,
        revision: plan.entry.revision,
        plugin: None,
        detects: &detects,
    };
    let mut touched = Touched::default();
    let mut left = plan.entry.clone();
    let mut journal_failed = None;
    // Experts links an agent done could not give back (another agent of
    // the plugin still provides the name where they go): kept for later.
    let mut deferred: Vec<ExpertLink> = Vec::new();
    // Every agent's removal, in order; then the Experts links back, once
    // no agent of the plugin's provides their names any more.
    let mut removed = Vec::new();
    for (agent, host) in &plan.order {
        let (agent, mode) = (*agent, host.mode);
        let agent_wire = wire(agent);
        let step_wire = agent_wire.clone();
        let (back, planned) = locked(&guard, move || {
            let planned = tx.step_planned(&step_wire, mode, "uninstall");
            (tx, planned)
        })
        .await?;
        tx = back;
        let index = match planned {
            Ok(index) => index,
            Err(error) => {
                journal_failed = Some(error);
                break;
            }
        };
        let step = Started {
            agent,
            mode,
            host_name: host.host_name.clone(),
            experts: host.experts.clone(),
            installing: true,
        };
        let mut outcome = HostOutcome::new(agent, mode);
        outcome.host_name = host.host_name.clone();
        let acks = plan.removes.get(&agent).map(OwnedPlan::acks);
        if remove_step(&op, &step, acks, &mut outcome, &mut touched).await? {
            removed.push((answer.hosts.len(), index, step));
        } else {
            outcome.status = HostStepStatus::NeedsRepair;
            // The repair finishes the uninstall: it never puts it back.
            if let Some(entry) = left.hosts.get_mut(&agent_wire) {
                entry.mark_uninstalling();
            }
            answer.needs_repair.push(agent);
        }
        answer.hosts.push(outcome);
    }
    for (at, index, step) in removed {
        if journal_failed.is_some() {
            break;
        }
        let agent_wire = wire(step.agent);
        let mut outcome = answer.hosts[at].clone();
        if experts_back(&op, &step.experts, &mut outcome, &mut touched).await? {
            left.hosts.remove(&agent_wire);
            deferred.extend(outcome.experts_left.iter().cloned());
            let (back, done) = locked(&guard, move || {
                let done = tx.step_done(index);
                (tx, done)
            })
            .await?;
            tx = back;
            if let Err(error) = done {
                journal_failed = Some(error);
            }
        } else {
            // Taken out, its Experts links not all back: those still to go
            // back are kept, to try again.
            outcome.status = HostStepStatus::NeedsRepair;
            let still = still_to_give_back(&op, &step.experts, &outcome).await?;
            if let Some(entry) = left.hosts.get_mut(&agent_wire) {
                entry.mark_uninstalling();
                entry.experts = still;
            }
            answer.needs_repair.push(step.agent);
        }
        answer.hosts[at] = outcome;
    }
    if let Some(error) = journal_failed {
        // The journal could not be kept up: the next start rolls it back,
        // marking every agent a step touched.
        answer.outcome = UninstallOutcome::WriteFailed;
        answer.issues.push(io_reason(&error));
        drop(guard);
        announce(emitter, &item_id, std::iter::empty(), &touched, false);
        return Ok(answer);
    }
    // Every agent done: the entry goes. Else the agents that are not done
    // stay, marked.
    let keeper = left
        .hosts
        .iter()
        .find(|(_, host)| host.state == HostState::NeedsRepair)
        .map(|(agent, _)| agent.clone());
    let deferred = if keeper.is_some() {
        held_back(&op, deferred).await?
    } else {
        Vec::new()
    };
    carry_experts(&mut left.hosts, keeper.as_ref(), deferred);
    let after = (!left.hosts.is_empty()).then_some(left);
    let (back, committed) = locked(&guard, move || {
        let committed = match after {
            Some(after) => tx.set_after(Some(after)).and_then(|()| tx.commit()),
            None => tx.commit(),
        };
        (tx, committed)
    })
    .await?;
    tx = back;
    match committed {
        Ok(()) => {
            match locked(&guard, move || tx.finish()).await? {
                Ok(problems) => answer.problems = problems,
                Err(error) => answer.problems.push(error.to_string()),
            }
            answer.outcome = if answer.needs_repair.is_empty() {
                UninstallOutcome::Uninstalled
            } else {
                answer.issues.push(
                    Reason::new(codes::NEEDS_REPAIR).param(
                        "agents",
                        answer
                            .needs_repair
                            .iter()
                            .map(|agent| wire(*agent))
                            .collect::<Vec<_>>()
                            .join(","),
                    ),
                );
                UninstallOutcome::WriteFailed
            };
        }
        Err(error) => {
            // Not committed: rolled back, every agent a step touched marked.
            answer.outcome = UninstallOutcome::WriteFailed;
            answer.issues.push(io_reason(&error));
            let touched_agents: BTreeSet<String> = tx.journal().touched();
            match locked(&guard, move || tx.rollback(&touched_agents)).await? {
                Ok(marked) => {
                    answer.needs_repair = marked
                        .iter()
                        .filter_map(|agent| AgentType::from_wire(agent))
                        .collect();
                }
                Err(error) => answer.issues.push(io_reason(&error)),
            }
        }
    }
    drop(guard);
    let agents: Vec<AgentType> = plan.order.iter().map(|(agent, _)| *agent).collect();
    announce(emitter, &item_id, agents, &touched, true);
    Ok(answer)
}
