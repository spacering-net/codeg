//! The plugins guard: what runs on its own in a plugin that an agent has
//! whole is switched off the moment SRN no longer vouches for the installed
//! revision (docs/harness-plugins.md §7 「SRN 上已没有的条目」「公告与开关」
//! on the website).
//!
//! The update check calls [`Guard::enforce`] right after a check that got an
//! answer, with that answer only (`harness::updates`). For each installed
//! plugin with something that runs on its own (`autorun` in the record),
//! when the answer about its installed revision says:
//!
//! - the item is `unavailable`, `retired` or `removed`;
//! - the revision is `yanked` or `blocked`;
//! - the revision is no longer approved (`approved: false`);
//! - an advisory asks for it to be switched off or taken out;
//!
//! every agent that has it as a plugin and runs it (`Native`, `Active`) is
//! switched off in its host (the adapter's `disable`), its files kept, and
//! recorded `Suspended { reason }` — one journaled operation per plugin,
//! under the plugins lock, announced as the plugin operations are.
//!
//! What it never does: switch anything on, take anything out, or touch an
//! agent that has the plugin's skills only (the update check's marks say
//! enough there), one switched off already, or one needing repair. Only an
//! update the user agrees to turns a `Suspended` agent on again. `full`
//! moving on to a newer approved revision is no reason (the installed one is
//! still approved: an update to offer). A check that failed, an answer that
//! does not tell (an item status or revision status this Codeg does not
//! know, no such revision, no plugin part, no answer about the installed
//! revision at all) switches nothing off. The server's adapter switch is not
//! looked at (decision 4: it holds back new installs and updates only).
//!
//! An agent whose host cannot be switched off (the command fails, the host
//! is gone, its launch environment cannot be read) is not left running
//! unrecorded: it is marked `NeedsRepair`, with the note that it was to be
//! `Suspended` — the repair then only switches it off and repoints it. That
//! mark is written before any host is touched, so a journal or record that
//! cannot be written, or a crash, leaves the same.
//!
//! Idempotent: an agent `Suspended` already is not `Active`, so a second
//! check with the same answer runs no host command.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Arc;

use futures::future::BoxFuture;

use crate::app_error::AppCommandError;
use crate::harness::mcp::model::codes as shared;
use crate::harness::skills::Local as SkillsLocal;
use crate::harness::types::{ItemStatus, VersionStatus};
use crate::harness::updates::Answer;
use crate::models::agent::AgentType;
use crate::web::event_bridge::EventEmitter;

use super::ctx::{InstallName, PluginsCtx};
use super::hosts::{HostCx, HostEnv, HostPlugin};
use super::install::{announce, locked, off_thread, wire, PluginsLocal, Touched};
use super::journal::{Action, Tx};
use super::lock::PluginsGuard;
use super::model::codes;
use super::record::{self, HostMode, HostState, PluginEntry};
use super::switches::AdapterSwitches;

/// Why the guard switches a plugin off, by the answer about its installed
/// revision — the `Suspended` reason, the same codes the repair writes
/// (`update::not_vouched`). `None`: SRN vouches for it, or the answer does
/// not tell.
pub(crate) fn not_vouched(answer: &Answer) -> Option<&'static str> {
    match answer.status {
        ItemStatus::Unavailable | ItemStatus::Retired | ItemStatus::Removed => {
            return Some(shared::ITEM_UNAVAILABLE)
        }
        // never read as anything the catalog said
        ItemStatus::Unknown => return None,
        ItemStatus::Public | ItemStatus::Listed => {}
    }
    match answer.version_status {
        Some(VersionStatus::Blocked) => return Some(shared::VERSION_BLOCKED),
        Some(VersionStatus::Yanked) => return Some(shared::YANKED),
        Some(VersionStatus::Ok)
            if answer
                .plugin
                .as_ref()
                .is_some_and(|plugin| !plugin.approved) =>
        {
            return Some(codes::NOT_APPROVED)
        }
        _ => {}
    }
    answer.disable_advisory.then_some(codes::ADVISORY_DISABLE)
}

/// One agent the guard switched off.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Disabled {
    pub item_id: String,
    pub name: String,
    pub agent: AgentType,
    /// The `Suspended` reason.
    pub reason: String,
    /// Off in its host and `Suspended`. `false`: its host could not be
    /// switched off; the agent is marked `NeedsRepair` (its repair leaves it
    /// off).
    pub suspended: bool,
}

/// Why the guard did not act on (all of) an answer now: the plugins lock was
/// held (another operation on the plugins), the record could not be read or
/// written, or the agents' environments could not be had. The same answer
/// is acted on later.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Deferred(pub String);

impl std::fmt::Display for Deferred {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// The local side for the agents given: the store, the adapters and each
/// agent's launch environment. `None`: it cannot be had now.
pub(crate) type LocalSource =
    Arc<dyn Fn(Vec<AgentType>) -> BoxFuture<'static, Option<PluginsLocal>> + Send + Sync>;

/// The guard of one process: where the plugins record is, and how to get
/// the local side once something is to be switched off.
#[derive(Clone)]
pub(crate) struct Guard {
    ctx: PluginsCtx,
    source: LocalSource,
}

/// This machine's guard: the real store and hosts, each agent's launch
/// environment read from its settings (`db`) as a session's launch reads it.
pub(crate) fn here(db: &crate::db::AppDatabase, data_dir: &Path) -> Guard {
    let conn = db.conn.clone();
    let data_dir = data_dir.to_path_buf();
    Guard {
        ctx: PluginsCtx::user(),
        source: Arc::new(move |agents| {
            let db = crate::db::AppDatabase { conn: conn.clone() };
            let data_dir = data_dir.clone();
            Box::pin(async move {
                let envs = launch_envs(&db, &data_dir, &agents).await;
                Some(PluginsLocal::here(SkillsLocal::here(), envs))
            })
        }),
    }
}

/// Each agent's launch environment (the overrides its sessions start with),
/// as `HostEnv`. An agent whose settings cannot be read is left out: what
/// it runs is not guessed at with Codeg's own environment.
pub(crate) async fn launch_envs(
    db: &crate::db::AppDatabase,
    data_dir: &Path,
    agents: &[AgentType],
) -> BTreeMap<AgentType, HostEnv> {
    let mut envs = BTreeMap::new();
    for agent in agents {
        match crate::commands::acp::build_runtime_env_for_agent(db, *agent, None, data_dir, true)
            .await
        {
            Ok(overrides) => {
                envs.insert(*agent, HostEnv::agent(overrides));
            }
            Err(error) => tracing::warn!(
                %agent,
                "[Harness plugins] launch environment not read: {error}"
            ),
        }
    }
    envs
}

impl Guard {
    /// A guard over `local` as it is (tests: stand-in hosts and
    /// environments).
    #[cfg(all(test, unix))]
    pub(crate) fn fixed(local: PluginsLocal) -> Self {
        Self {
            ctx: local.plugins.clone(),
            source: Arc::new(move |_| {
                let local = local.clone();
                Box::pin(async move { Some(local) })
            }),
        }
    }

    /// Switch off what SRN no longer vouches for, by `answers` (a check's
    /// that got an answer; see the module docs). Returns the agents switched
    /// off (or marked, when their host could not be).
    pub(crate) async fn enforce(
        &self,
        emitter: &EventEmitter,
        answers: &[Answer],
    ) -> Result<Vec<Disabled>, Deferred> {
        // Read without the lock first: most checks find nothing to do.
        let ctx = self.ctx.clone();
        let answers_owned = answers.to_vec();
        let found = off_thread(move || candidates(&ctx, &answers_owned))
            .await
            .map_err(|error| Deferred(error.to_string()))?
            .map_err(Deferred)?;
        if found.is_empty() {
            return Ok(Vec::new());
        }
        let agents: BTreeSet<AgentType> = found
            .iter()
            .flat_map(|found| found.agents.iter().copied())
            .collect();
        let Some(local) = (self.source)(agents.into_iter().collect()).await else {
            return Err(Deferred("the agents' environments cannot be read".into()));
        };
        enforce(&local, emitter, answers).await
    }
}

/// A plugin to switch off, as the record had it before the lock.
struct Candidate {
    agents: Vec<AgentType>,
}

/// What the answers may ask to be switched off: per plugin with something
/// that runs on its own whose installed revision SRN no longer vouches for,
/// every agent that has it as a plugin — whatever its state now: an
/// operation holding the lock may be switching one on, and what it leaves
/// is looked at under the lock.
/// A record that cannot be read now is looked at again later.
fn candidates(ctx: &PluginsCtx, answers: &[Answer]) -> Result<Vec<Candidate>, String> {
    let record = record::load(ctx).map_err(|error| error.to_string())?;
    Ok(record
        .plugins
        .values()
        .filter(|entry| reason_for(entry, answers).is_some())
        .map(|entry| Candidate {
            agents: native(entry),
        })
        .filter(|candidate| !candidate.agents.is_empty())
        .collect())
}

/// Why `entry` is to be switched off, by the answer about its revision.
fn reason_for(entry: &PluginEntry, answers: &[Answer]) -> Option<&'static str> {
    if entry.autorun.is_empty() {
        return None;
    }
    answers
        .iter()
        .find(|answer| answer.id == entry.item_id && answer.revision == entry.revision)
        .and_then(not_vouched)
}

/// The agents that have it as a plugin, in any state.
fn native(entry: &PluginEntry) -> Vec<AgentType> {
    entry
        .hosts
        .iter()
        .filter(|(_, host)| host.mode == HostMode::Native)
        .filter_map(|(agent, _)| AgentType::from_wire(agent))
        .collect()
}

/// The agents that have it as a plugin and run it.
fn running(entry: &PluginEntry) -> Vec<AgentType> {
    entry
        .hosts
        .iter()
        .filter(|(_, host)| host.mode == HostMode::Native && host.state == HostState::Active)
        .filter_map(|(agent, _)| AgentType::from_wire(agent))
        .collect()
}

/// [`Guard::enforce`] with the local side at hand.
pub(crate) async fn enforce(
    local: &PluginsLocal,
    emitter: &EventEmitter,
    answers: &[Answer],
) -> Result<Vec<Disabled>, Deferred> {
    let guard = match local.plugins.lock().await {
        Ok(guard) => Arc::new(guard),
        Err(error) => return Err(Deferred(error.to_string())),
    };
    let (ctx, answers_owned) = (local.plugins.clone(), answers.to_vec());
    let plugins = locked(&guard, move || {
        let record = record::load_for_write(&ctx).map_err(|error| error.to_string())?;
        Ok::<_, String>(
            record
                .plugins
                .into_iter()
                .filter_map(|(key, entry)| {
                    let reason = reason_for(&entry, &answers_owned)?;
                    let name = InstallName::parse(&key)?;
                    (!running(&entry).is_empty()).then_some((name, entry, reason))
                })
                .collect::<Vec<_>>(),
        )
    })
    .await
    .map_err(|error| Deferred(error.to_string()))?
    .map_err(Deferred)?;
    let mut disabled = Vec::new();
    // Plugins nothing was recorded for yet (the record could not be
    // written): the same answer is acted on again later.
    let mut again: Vec<String> = Vec::new();
    for (name, entry, reason) in plugins {
        match suspend(local, &guard, &name, entry, reason).await {
            Ok(Ok(done)) => disabled.extend(done),
            Ok(Err(why)) => again.push(format!("{name}: {why}")),
            Err(error) => again.push(format!("{name}: {error}")),
        }
    }
    drop(guard);
    // Announced once the lock is let go: what reads the record now sees it.
    let mut by_item: BTreeMap<String, Vec<AgentType>> = BTreeMap::new();
    for done in &disabled {
        by_item
            .entry(done.item_id.clone())
            .or_default()
            .push(done.agent);
    }
    for (item_id, agents) in by_item {
        announce(emitter, &item_id, agents, &Touched::default(), true);
    }
    if !again.is_empty() {
        return Err(Deferred(again.join("; ")));
    }
    Ok(disabled)
}

/// Run `work` on the journal under the lock, handing it back.
async fn on_tx<T: Send + 'static>(
    guard: &Arc<PluginsGuard>,
    tx: Tx,
    work: impl FnOnce(&mut Tx) -> std::io::Result<T> + Send + 'static,
) -> Result<(Tx, std::io::Result<T>), AppCommandError> {
    locked(guard, move || {
        let mut tx = tx;
        let done = work(&mut tx);
        (tx, done)
    })
    .await
}

/// One plugin's running agents switched off and recorded `Suspended`.
///
/// First the record marks each of them as needing repair, with the note
/// that it was to be `Suspended` — written before any host is touched, so
/// that whatever stops this midway (a failed step, a journal or record that
/// cannot be written, a crash) leaves an agent the repair only switches off
/// and leaves `Suspended`, whatever SRN says by then. Then one journaled
/// operation: each host switched off, and the record committed with those
/// that went through `Suspended`; one whose host could not be switched off
/// stays marked. `Err` inside: not even the marks could be written — no
/// host touched; the answer is to be acted on again.
async fn suspend(
    local: &PluginsLocal,
    guard: &Arc<PluginsGuard>,
    name: &InstallName,
    entry: PluginEntry,
    reason: &'static str,
) -> Result<Result<Vec<Disabled>, String>, AppCommandError> {
    let agents = running(&entry);
    let mut marked = entry.clone();
    for agent in &agents {
        if let Some(host) = marked.hosts.get_mut(&wire(*agent)) {
            host.state = HostState::suspended(reason);
            host.mark_needs_repair([]);
        }
    }
    let (ctx, key, entry_now) = (local.plugins.clone(), name.to_string(), marked.clone());
    let premarked = locked(guard, move || {
        let mut record = record::load_for_write(&ctx)?;
        record.plugins.insert(key, entry_now);
        record::save(&ctx, &record)
    })
    .await?;
    if let Err(error) = premarked {
        return Ok(Err(format!("not marked: {error}")));
    }

    let mut after = marked.clone();
    let (ctx, held, begin_name, begin_after) = (
        local.plugins.clone(),
        guard.clone(),
        name.clone(),
        after.clone(),
    );
    let mut tx = match locked(guard, move || {
        Tx::begin(&ctx, &held, Action::Change, &begin_name, Some(begin_after))
    })
    .await?
    {
        Ok(tx) => tx,
        Err(error) => {
            // Marked, nothing switched off yet: the repair does it.
            tracing::warn!("[Harness plugins] guard: {name} not switched off: {error}");
            return Ok(Ok(unswitched(&entry, name, &agents, reason)));
        }
    };

    let mut done = Vec::new();
    let mut touched: BTreeSet<String> = BTreeSet::new();
    let mut journal_error = None;
    for agent in &agents {
        let agent = *agent;
        let agent_wire = wire(agent);
        let step_wire = agent_wire.clone();
        let (back, planned) = on_tx(guard, tx, move |tx| {
            tx.step_planned(&step_wire, HostMode::Native, "disable")
        })
        .await?;
        tx = back;
        let index = match planned {
            Ok(index) => index,
            Err(error) => {
                journal_error = Some(error);
                break;
            }
        };
        touched.insert(agent_wire.clone());
        let switched = switch_off(local, guard, name, &entry, agent).await;
        match &switched {
            Ok(()) => {
                if let (Some(host), Some(before)) = (
                    after.hosts.get_mut(&agent_wire),
                    entry.hosts.get(&agent_wire),
                ) {
                    host.state = HostState::suspended(reason);
                    host.repair = before.repair.clone();
                }
            }
            // Still marked: the repair switches it off and leaves it
            // `Suspended` (`RepairNote::was`).
            Err(why) => tracing::warn!(
                "[Harness plugins] guard: {name} not switched off for {agent_wire}: {} {}",
                why.code,
                why.detail.as_deref().unwrap_or_default()
            ),
        }
        done.push(Disabled {
            item_id: entry.item_id.clone(),
            name: name.to_string(),
            agent,
            reason: reason.to_string(),
            suspended: switched.is_ok(),
        });
        let now = after.clone();
        let (back, written) = on_tx(guard, tx, move |tx| {
            tx.set_after(Some(now))?;
            tx.step_done(index)
        })
        .await?;
        tx = back;
        if let Err(error) = written {
            journal_error = Some(error);
            break;
        }
    }

    if journal_error.is_none() {
        let (back, committed) = on_tx(guard, tx, |tx| tx.commit()).await?;
        tx = back;
        match committed {
            Ok(()) => {
                match locked(guard, move || tx.finish()).await? {
                    Ok(problems) => {
                        for problem in problems {
                            tracing::warn!("[Harness plugins] guard: {problem}");
                        }
                    }
                    Err(error) => tracing::warn!("[Harness plugins] guard: {error}"),
                }
                return Ok(Ok(done));
            }
            Err(error) => journal_error = Some(error),
        }
    }
    // Not committed: nothing is switched on again (a guard never does). The
    // record keeps the marks written first (the rollback keeps each note);
    // the repair switches them off and leaves them `Suspended`.
    if let Some(error) = journal_error {
        tracing::warn!("[Harness plugins] guard: {name}: {error}");
    }
    let (back, undoing) = on_tx(guard, tx, |tx| tx.undoing()).await?;
    if let Err(error) = undoing {
        tracing::warn!("[Harness plugins] guard: {name}: {error}");
    }
    if let Err(error) = locked(guard, move || back.rollback(&touched)).await? {
        // The journal stays: the next start rolls it back the same way.
        tracing::warn!("[Harness plugins] guard: {name}: {error}");
    }
    Ok(Ok(unswitched(&entry, name, &agents, reason)))
}

/// `agents` as marked for repair, none recorded switched off.
fn unswitched(
    entry: &PluginEntry,
    name: &InstallName,
    agents: &[AgentType],
    reason: &str,
) -> Vec<Disabled> {
    agents
        .iter()
        .map(|agent| Disabled {
            item_id: entry.item_id.clone(),
            name: name.to_string(),
            agent: *agent,
            reason: reason.to_string(),
            suspended: false,
        })
        .collect()
}

/// The host's own switch, off, for `agent` — never anything that could
/// switch it on. The agent's own launch environment, or none at all.
async fn switch_off(
    local: &PluginsLocal,
    guard: &Arc<PluginsGuard>,
    name: &InstallName,
    entry: &PluginEntry,
    agent: AgentType,
) -> Result<(), crate::harness::mcp::model::Reason> {
    use crate::harness::mcp::model::Reason;
    let Some((host, adapter)) = local.adapter(agent) else {
        return Err(local.no_adapter(agent));
    };
    let Some(env) = local.envs.get(&agent) else {
        return Err(Reason::new(codes::HOST_STEP_FAILED)
            .param("agent", wire(agent))
            .param("step", "disable")
            .detail("the agent's launch environment cannot be read"));
    };
    // Whatever the server's switch says now: what an agent has is always
    // switched off.
    let detect = adapter.detect(env, &AdapterSwitches::default()).await;
    let cx = HostCx {
        ctx: &local.plugins,
        env,
        cli: detect.cli.as_ref(),
        lock: guard,
    };
    let host_name = entry
        .hosts
        .get(&wire(agent))
        .and_then(|host| host.host_name.as_deref());
    let plugin = HostPlugin::new(name, entry.revision, None, host).with_host_name(host_name);
    adapter.disable(&cx, &plugin).await
}
