//! The installed plugins as the installed list shows them
//! (`harness_installed`'s `plugins`), and the Codex hook trust it asks for
//! on demand (`harness_plugin_hook_trust`).
//!
//! The listing reads this machine only: the record, the revision folders
//! (each checked against its listing) and, for every agent that runs a
//! plugin whole, what its host has of it — the adapters' `verify`, which
//! reads the hosts' files and never runs a host command. That check is
//! made under the plugins lock, waited for briefly: while another operation
//! holds it the rows come without it (`problems`: `lock_busy`). An agent
//! whose launch environment could not be read is not checked with a
//! guessed one. A record that cannot be read — or that a newer Codeg wrote —
//! is the caller's `plugins_problem`; nothing else of the listing depends on
//! it.
//!
//! Codex's trust of a plugin's hooks is Codex's own answer (its app-server,
//! a host process): asked only by [`hook_trust`], for one agent, never by
//! the listing.

use std::time::Duration;

use serde::Serialize;

use crate::app_error::AppCommandError;
use crate::harness::mcp::model::{codes as shared, Reason};
use crate::harness::types::PluginComponent;
use crate::harness::updates::UpdateItem;
use crate::models::agent::AgentType;
use crate::skills::owned::ExpertLink;

use super::ctx::InstallName;
use super::hosts::{self, HookTrust, HostCx, HostId, HostPlugin, HostVerify};
use super::install::{off_thread, wire, PluginsLocal};
use super::lock::PluginsGuard;
use super::model::codes;
use super::record::{
    self, AutorunEntry, HostMode, HostState, PluginEntry, RecordComponent, RepairNote,
};
use super::store::{self, Mismatch};
use super::switches::AdapterSwitches;

/// How long the listing waits for the plugins lock before it lists without
/// the hosts' checks.
const LISTING_LOCK_WAIT: Duration = Duration::from_millis(500);

/// One installed plugin, one row.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ListedPlugin {
    /// The install name.
    pub name: String,
    pub item_id: String,
    #[serde(rename = "ref")]
    pub item_ref: String,
    pub revision: u64,
    pub version: Option<String>,
    /// The revision before, kept until the next operation.
    pub previous_revision: Option<u64>,
    pub installed_at: String,
    /// What runs on its own in this revision, as the user agrees to it.
    pub exec_sha256: String,
    /// The `exec_sha256` the user agreed to; `null`: none.
    pub consent: Option<String>,
    /// What runs on its own once installed whole.
    pub autorun: Vec<AutorunEntry>,
    /// Its skills and assistants.
    pub members: Vec<PluginComponent>,
    /// One per agent, in the record's order.
    pub hosts: Vec<ListedHost>,
    /// What the last update check says of it; `null`: nothing yet.
    pub update: Option<UpdateItem>,
    /// What the listing found wrong with the plugin's own files, or why it
    /// could not check the hosts (`lock_busy`).
    pub problems: Vec<Reason>,
}

/// How one agent has the plugin.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ListedHost {
    /// The agent's wire id (one this Codeg does not know is kept as it is).
    pub agent: String,
    /// The website's host id, for an agent whose host has an adapter.
    pub host_id: Option<String>,
    pub mode: HostMode,
    pub state: HostState,
    /// `Suspended`: why Codeg switched it off (a reason code).
    pub suspended_reason: Option<String>,
    /// `NeedsRepair`: what the operation that stopped left to know.
    pub repair: Option<RepairNote>,
    /// As a plugin: the name the host knows it by.
    pub host_name: Option<String>,
    /// Skills only: the member skills it has.
    pub skills: Vec<String>,
    /// The Experts pack's links the plugin took out of what it reads.
    pub experts: Vec<ExpertLink>,
    /// Codex runs the plugin's hooks only once the user trusts them there
    /// (`harness_plugin_hook_trust` tells which are).
    pub codex_hooks: bool,
    /// What its host has of the plugin against the record: an agent that
    /// runs it whole (`native`, `active`) only; `null` otherwise, or when
    /// it could not be checked.
    pub verify: Option<HostVerify>,
}

fn members_of(entry: &PluginEntry) -> Vec<PluginComponent> {
    entry
        .components
        .iter()
        .map(RecordComponent::to_component)
        .collect()
}

fn files_problem(revision: u64, problems: &[Mismatch]) -> Reason {
    if problems.contains(&Mismatch::NotAFolder) {
        return Reason::new(hosts::codes::REVISION_MISSING).param("revision", revision.to_string());
    }
    let shown: Vec<String> = problems.iter().take(5).map(ToString::to_string).collect();
    Reason::new(codes::REVISION_MODIFIED)
        .param("revision", revision.to_string())
        .detail(shown.join("; "))
}

fn row(name: &str, entry: &PluginEntry, update: Option<UpdateItem>) -> ListedPlugin {
    let codex_hooks = entry
        .autorun
        .iter()
        .any(|part| part.host == HostId::Codex.as_str() && part.part_type == "hook");
    ListedPlugin {
        name: name.to_string(),
        item_id: entry.item_id.clone(),
        item_ref: entry.item_ref.clone(),
        revision: entry.revision,
        version: entry.version.clone(),
        previous_revision: entry.previous_revision,
        installed_at: entry.installed_at.clone(),
        exec_sha256: entry.exec_sha256.clone(),
        consent: entry.consent.as_ref().map(|consent| consent.exec.clone()),
        autorun: entry.autorun.clone(),
        members: members_of(entry),
        hosts: entry
            .hosts
            .iter()
            .map(|(agent, host)| {
                let host_id = AgentType::from_wire(agent).and_then(HostId::for_agent);
                ListedHost {
                    agent: agent.clone(),
                    host_id: host_id.map(|host| host.as_str().to_string()),
                    mode: host.mode,
                    state: host.state.clone(),
                    suspended_reason: match &host.state {
                        HostState::Suspended { reason, .. } => Some(reason.clone()),
                        _ => None,
                    },
                    repair: host.repair.clone(),
                    host_name: host.host_name.clone(),
                    skills: host.skills.clone(),
                    experts: host.experts.clone(),
                    codex_hooks: codex_hooks
                        && host.mode == HostMode::Native
                        && host_id == Some(HostId::Codex),
                    verify: None,
                }
            })
            .collect(),
        update,
        problems: Vec::new(),
    }
}

/// The record's entries and each revision folder's check, read off the
/// async runtime.
type Read = Vec<(String, PluginEntry, Option<Reason>)>;

fn read(ctx: &super::PluginsCtx) -> Result<Read, Reason> {
    let record = record::load_for_write(ctx)
        .map_err(|error| Reason::new(shared::RECORD_UNREADABLE).detail(error.detail()))?;
    Ok(record
        .plugins
        .into_iter()
        .map(|(key, entry)| {
            let files = InstallName::parse(&key).and_then(|name| {
                let dir = ctx.revision_dir(&name, entry.revision);
                store::verify_revision(&dir, &entry.listing())
                    .err()
                    .map(|problems| files_problem(entry.revision, &problems))
            });
            (key, entry, files)
        })
        .collect())
}

/// Every installed plugin (see the module docs). `updates`: the update
/// check's last answers. `Err`: the record cannot be read (its reason).
pub(crate) async fn installed(
    local: &PluginsLocal,
    updates: &[UpdateItem],
) -> Result<Result<Vec<ListedPlugin>, Reason>, AppCommandError> {
    let mut ctx = local.plugins.clone();
    ctx.lock_wait = LISTING_LOCK_WAIT;
    let guard = ctx.lock().await;
    let reading = local.plugins.clone();
    let read = match off_thread(move || read(&reading)).await? {
        Ok(read) => read,
        Err(reason) => return Ok(Err(reason)),
    };
    let mut rows = Vec::new();
    for (name, entry, files) in read {
        let update = updates
            .iter()
            .find(|item| item.id == entry.item_id)
            .cloned();
        let mut listed = row(&name, &entry, update);
        listed.problems.extend(files);
        match &guard {
            Ok(guard) => verify_hosts(local, guard, &name, &entry, &mut listed).await,
            Err(error) => listed
                .problems
                .push(Reason::new(error.code()).detail(error.to_string())),
        }
        rows.push(listed);
    }
    Ok(Ok(rows))
}

/// Each agent that runs the plugin whole: what its host has of it.
async fn verify_hosts(
    local: &PluginsLocal,
    guard: &PluginsGuard,
    name: &str,
    entry: &PluginEntry,
    listed: &mut ListedPlugin,
) {
    let Some(name) = InstallName::parse(name) else {
        return;
    };
    for host in &mut listed.hosts {
        if host.mode != HostMode::Native || host.state != HostState::Active {
            continue;
        }
        let Some(agent) = AgentType::from_wire(&host.agent) else {
            continue;
        };
        let Some((host_id, adapter)) = local.adapter(agent) else {
            continue;
        };
        let Some(env) = local.envs.get(&agent) else {
            host.verify = Some(HostVerify {
                enabled: None,
                problems: vec![Reason::new(codes::ENV_UNREADABLE).param("agent", wire(agent))],
            });
            continue;
        };
        // `verify` reads files only: no command, so no host program.
        let cx = HostCx {
            ctx: &local.plugins,
            env,
            cli: None,
            lock: guard,
        };
        let plugin = HostPlugin::new(&name, entry.revision, None, host_id)
            .with_host_name(host.host_name.as_deref());
        host.verify = Some(adapter.verify(&cx, &plugin).await);
    }
}

/// What Codex's own trust says of the plugin's hooks for `agent` (see the
/// module docs). Read-only: Codeg never trusts a hook for the user. A host
/// that keeps no trust of its own, an agent without the plugin as a plugin,
/// or a lock that could not be had: no hooks, with the reason.
pub(crate) async fn hook_trust(
    local: &PluginsLocal,
    item_id: &str,
    agent: AgentType,
) -> Result<HookTrust, AppCommandError> {
    let ctx = local.plugins.clone();
    let read = off_thread(move || record::load(&ctx)).await?;
    let record = read.map_err(|error| {
        AppCommandError::task_execution_failed(format!("Harness plugins: {error}"))
    })?;
    let Some((key, entry)) = record
        .plugins
        .iter()
        .find(|(_, entry)| entry.item_id == item_id)
    else {
        return Err(AppCommandError::not_found("This plugin is not installed"));
    };
    let without = |reason: Reason| HookTrust {
        hooks: Vec::new(),
        problem: Some(reason),
    };
    let native = entry
        .hosts
        .get(&wire(agent))
        .filter(|host| host.mode == HostMode::Native);
    let (Some(host), Some(name)) = (native, InstallName::parse(key)) else {
        return Ok(without(
            Reason::new(codes::NOT_ON_AGENT).param("agent", wire(agent)),
        ));
    };
    let Some((host_id, adapter)) = local.adapter(agent) else {
        return Ok(without(
            local.no_adapter(agent),
        ));
    };
    let Some(env) = local.envs.get(&agent) else {
        return Ok(without(
            Reason::new(codes::ENV_UNREADABLE).param("agent", wire(agent)),
        ));
    };
    let detect = adapter.detect(env, &AdapterSwitches::default()).await;
    let guard = match local.plugins.lock().await {
        Ok(guard) => guard,
        Err(error) => return Ok(without(Reason::new(error.code()).detail(error.to_string()))),
    };
    let cx = HostCx {
        ctx: &local.plugins,
        env,
        cli: detect.cli.as_ref(),
        lock: &guard,
    };
    let plugin = HostPlugin::new(&name, entry.revision, None, host_id)
        .with_host_name(host.host_name.as_deref());
    Ok(adapter.hook_trust(&cx, &plugin).await.unwrap_or_default())
}
