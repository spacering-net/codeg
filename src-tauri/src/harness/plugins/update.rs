//! An installed Harness plugin moved on to another revision, or changed for
//! one agent (docs/harness-plugins.md §7 「更新」「已装列表」 on the website).
//!
//! - **Update** ([`plan_update`], [`update`]): one revision for every
//!   agent, chosen as the install chooses it — `full` while any agent has it
//!   as a plugin, else the latest — so while the latest waits for review the
//!   skills-only agents stay on `full` too, and move with the others once it
//!   is approved. An agent whose host can no longer take the target whole
//!   (the server's switch, its version, the website no longer listing the
//!   host) goes on with its skills only. What runs on its own is agreed to
//!   again when its `execSha256` is not the one agreed to, and whenever an
//!   agent Codeg turned off (`Suspended`) is to run it again: only an update
//!   the user agrees to turns such an agent on. One switched off by the user
//!   stays off (Codex: `plugin add` would turn it on; its adapter keeps it
//!   off). The prompt says the versions and which members changed (by their
//!   `treeSha256`).
//! - **A change of mode** ([`set_host_mode`]): one agent's side taken out
//!   and the other put in at the record's revision, with the install's gates
//!   for a plugin (the revision is `full` and approved, no unpinned MCP
//!   server, the user's agreement, the server's switch, the host found);
//!   "not at all" gives the Experts pack's links back.
//! - **Off and on** ([`set_enabled`]): the host's own switch; skills only:
//!   the agent's links out, and back. Turning on something that runs on its
//!   own needs SRN to vouch for the revision now.
//! - **Repair** ([`repair`]): an agent an interrupted operation left
//!   (`NeedsRepair`) gets the record's revision, mode and state again — the
//!   host step re-run (every one is safe to repeat), what a cut-short change
//!   of mode left of the other mode taken out, then checked (`verify`); an
//!   agent that was off, or runs what SRN no longer vouches for, is only
//!   switched off and repointed (never put in or run by a repair). An agent
//!   an uninstall stopped on (`RepairNote::uninstalling`) has the uninstall
//!   finished instead — the plugin out of it again, the Experts pack's links
//!   back, the agent out of the record (the entry too, with the last one).
//!   After a backup was restored (`RepairNote::restored`), an agent that ran
//!   it as a plugin keeps running it only when its host has it as the
//!   record says (`verify`); otherwise it is switched off and repointed.
//!
//! Each is one journaled operation under the plugins lock, built the same
//! way: every agent's steps ([`Act`]s), in the install's order (skills-only
//! agents whose links go into a shared directory, then those with one of
//! their own, then the hosts' own plugin systems); every agent's Experts
//! takeover first, each its own step; the links of members a revision no
//! longer has given back last. A failure undoes every step begun, latest
//! first (the journal marked as being undone first), so every agent is back
//! on the revision it had; one that cannot be undone is marked as needing
//! repair (a repair is the exception: an agent that fails stays as it was,
//! the others are done). Agents needing repair are left out of an update,
//! their revisions held (`held_revisions`) until they are repaired.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use crate::app_error::AppCommandError;
use crate::harness::mcp::model::{codes as shared, Reason};
use crate::harness::mcp::snapshot;
use crate::harness::skills::owned::{
    engine_reason, held_reason, plan_owned, plan_owned_in_turn, plan_remove_owned,
    plan_remove_owned_in_turn, read_members, remove_owned, replace_owned, OwnedMember, OwnedOrigin,
    OwnedPlan,
};
use crate::harness::skills::package::PackageFile;
use crate::harness::skills::{self as harness_skills, codes as skill_codes, package};
use crate::harness::types::{
    ComponentKind, FileEntry, InstallInfo, Kind, PluginComponent, PluginInfo, Resolved,
    VersionStatus,
};
use crate::harness::{Harness, ItemRef};
use crate::models::agent::AgentType;
use crate::skills::model::OpStatus;
use crate::skills::owned::{audience, experts_linked, ExpertLink, PluginOwner};
use crate::skills::SkillsCtx;
use crate::web::event_bridge::EventEmitter;

use super::ctx::{InstallName, PluginsCtx};
use super::hosts::opencode::OpenCodeAdapter;
use super::hosts::{self, Detect, HostCx, HostId, HostPlugin};
use super::install::{
    announce, carry_experts, experts_ack, fresh_refusal, give_experts_back, held_back,
    installed_view, io_reason, issue_reason, locked, native_why_not, now, off_thread,
    opencode_entry, plan_detect, plan_item, plan_revision, push_unique, read_rev,
    revision_blocking, step_order, still_to_give_back, take_experts, take_step, whole_blocking,
    wire, Op, PluginsLocal, Rev, Started, Touched,
};
use super::journal::{Action, Tx};
use super::lock::PluginsGuard;
use super::model::*;
use super::record::{self, Consent, HostEntry, HostMode, HostState, PluginEntry, RecordComponent};
use super::store;
use super::switches::AdapterSwitches;

// ─── A revision as a change works with it ───────────────────────────────

/// One revision: what the hosts and the skills engine are given of it.
#[derive(Clone)]
struct RevFiles {
    revision: u64,
    /// Its install info's plugin part, when it was read (the hosts'
    /// manifests, its name); a change made from the record alone has none.
    plugin: Option<PluginInfo>,
    components: Vec<PluginComponent>,
    listing: Vec<FileEntry>,
    origin: OwnedOrigin,
}

impl RevFiles {
    /// The record's revision, as its entry has it.
    fn recorded(entry: &PluginEntry, plugin: Option<PluginInfo>) -> Self {
        let components = if entry.components.is_empty() {
            plugin
                .as_ref()
                .map(|plugin| plugin.components.clone())
                .unwrap_or_default()
        } else {
            entry
                .components
                .iter()
                .map(RecordComponent::to_component)
                .collect()
        };
        Self {
            revision: entry.revision,
            plugin,
            components,
            listing: entry.listing(),
            origin: OwnedOrigin {
                item_id: entry.item_id.clone(),
                item_ref: entry.item_ref.clone(),
                revision: entry.revision,
                version: entry.version.clone(),
                archive_sha256: entry.archive_sha256.clone(),
                source: entry.source.as_ref().map(Into::into),
                state_sha256: entry.state_sha256.clone(),
            },
        }
    }

    /// A revision from its install info, with the fingerprint confirmed.
    fn of_info(info: &InstallInfo, plugin: &PluginInfo, state_sha256: &str) -> Self {
        Self {
            revision: info.version.revision,
            plugin: Some(plugin.clone()),
            components: plugin.components.clone(),
            listing: info.files.clone(),
            origin: OwnedOrigin {
                item_id: info.item.id.clone(),
                item_ref: info.item.r#ref.clone(),
                revision: info.version.revision,
                version: info.version.version.clone(),
                archive_sha256: info.archive.as_ref().map(|archive| archive.sha256.clone()),
                source: if info.archive.is_none() {
                    info.source.clone()
                } else {
                    None
                },
                state_sha256: state_sha256.to_string(),
            },
        }
    }

    fn skill_names(&self) -> Vec<String> {
        self.components
            .iter()
            .filter(|component| component.kind == ComponentKind::Skill)
            .map(|component| component.name.clone())
            .collect()
    }

    fn host_plugin<'a>(
        &'a self,
        name: &'a InstallName,
        host: HostId,
        host_name: Option<&'a str>,
    ) -> HostPlugin<'a> {
        HostPlugin::new(name, self.revision, self.plugin.as_ref(), host).with_host_name(host_name)
    }
}

/// Which of the operation's two revisions (the same one for a change).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum At {
    From,
    To,
}

/// One step for one agent. Every one is safe to repeat (the adapters' and
/// the skills engine's calls are), so a step that failed partway is undone
/// by its [`Act::undo`] like one that went through.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Act {
    /// Put in, switched on (only for an agent that had nothing, or that
    /// ran it).
    NativeInstall(At),
    /// `was_on`: it ran before, and an undo puts it back. One that was off
    /// cannot be put back without running it for a moment: its undo leaves
    /// the agent needing repair (which only switches off and repoints).
    NativeUninstall {
        at: At,
        was_on: bool,
    },
    /// Moved to `to`, as it is (on or off). `undo_off`: the agent was off
    /// before (a way on), so the undo switches it off and only repoints it
    /// ([`Act::NativeRepoint`]).
    NativeUpdate {
        from: At,
        to: At,
        undo_off: bool,
    },
    /// An agent that is off pointed at `to` without anything that could
    /// switch it on: Claude Code's marketplace entry rewritten, OpenCode has
    /// no entry while off; Codex is left as it is (`plugin add` switches a
    /// plugin on for a moment, and Codex runs its own copy: it is repointed
    /// when it is switched on — every way on starts with a `NativeUpdate`).
    NativeRepoint {
        from: At,
        to: At,
    },
    NativeEnable(At),
    NativeDisable(At),
    /// The revision's members in the plugin's store, linked into the agent
    /// (`replace_owned`); undone by `undo_to`'s, or — none — by taking the
    /// agent's links out.
    SkillsPut {
        at: At,
        undo_to: Option<At>,
    },
    /// The agent's links out (`remove_owned`).
    SkillsRemove(At),
}

impl Act {
    fn label(self) -> &'static str {
        match self {
            Act::NativeInstall(_) => "install",
            Act::NativeUninstall { .. } => "uninstall",
            Act::NativeUpdate { .. } => "update",
            Act::NativeRepoint { .. } => "repoint",
            Act::NativeEnable(_) => "enable",
            Act::NativeDisable(_) => "disable",
            Act::SkillsPut { .. } => "put_skills",
            Act::SkillsRemove(_) => "remove_skills",
        }
    }

    fn mode(self) -> HostMode {
        match self {
            Act::SkillsPut { .. } | Act::SkillsRemove(_) => HostMode::Skills,
            _ => HostMode::Native,
        }
    }

    /// What undoes it; `None`: nothing undoes it without running what was
    /// off (the agent needs repair).
    fn undo(self) -> Option<Vec<Act>> {
        Some(match self {
            Act::NativeInstall(at) => vec![Act::NativeUninstall { at, was_on: true }],
            Act::NativeUninstall { at, was_on: true } => vec![Act::NativeInstall(at)],
            Act::NativeUninstall { was_on: false, .. } => return None,
            Act::NativeUpdate {
                from,
                to,
                undo_off: false,
            } => vec![Act::NativeUpdate {
                from: to,
                to: from,
                undo_off: false,
            }],
            // Off again (`plugin add` may have switched Codex on before it
            // failed), then pointed back.
            Act::NativeUpdate {
                from,
                to,
                undo_off: true,
            } => vec![
                Act::NativeDisable(to),
                Act::NativeRepoint { from: to, to: from },
            ],
            Act::NativeRepoint { from, to } => vec![Act::NativeRepoint { from: to, to: from }],
            Act::NativeEnable(at) => vec![Act::NativeDisable(at)],
            Act::NativeDisable(at) => vec![Act::NativeEnable(at)],
            Act::SkillsPut {
                undo_to: Some(back),
                ..
            } => vec![Act::SkillsPut {
                at: back,
                undo_to: None,
            }],
            Act::SkillsPut { at, undo_to: None } => vec![Act::SkillsRemove(at)],
            Act::SkillsRemove(at) => vec![Act::SkillsPut { at, undo_to: None }],
        })
    }
}

/// One agent's part in an operation.
#[derive(Debug, Clone)]
struct AgentPlan {
    agent: AgentType,
    before: Option<HostEntry>,
    /// How the record has the agent once through; `None`: not at all.
    after: Option<HostEntry>,
    acts: Vec<Act>,
    /// It provides the target's skills once through: the Experts pack's
    /// links of their names come out of what it reads first.
    take_over: bool,
    /// The Experts pack's links it gives back once through.
    give_back: Vec<ExpertLink>,
    /// An update's row.
    action: UpdateAction,
    why_not: Option<Reason>,
}

impl AgentPlan {
    fn new(agent: AgentType, before: Option<HostEntry>) -> Self {
        Self {
            agent,
            after: before.clone(),
            before,
            acts: Vec::new(),
            take_over: false,
            give_back: Vec::new(),
            action: UpdateAction::None,
            why_not: None,
        }
    }

    /// The mode its place in the order goes by.
    fn order_mode(&self) -> HostMode {
        self.after
            .as_ref()
            .or(self.before.as_ref())
            .map(|host| host.mode)
            .unwrap_or(HostMode::Skills)
    }

    fn puts(&self) -> bool {
        self.acts
            .iter()
            .any(|act| matches!(act, Act::SkillsPut { .. }))
    }

    fn removes(&self) -> bool {
        self.acts
            .iter()
            .any(|act| matches!(act, Act::SkillsRemove(_)))
    }
}

fn sort_plans(ctx: &SkillsCtx, plans: &mut [AgentPlan]) {
    plans.sort_by_key(|plan| step_order(ctx, plan.agent, plan.order_mode()));
}

/// The record's entry with every agent as the plans leave it (agents not
/// planned are kept as they are).
fn entry_after(before: &PluginEntry, plans: &[AgentPlan]) -> PluginEntry {
    let mut after = before.clone();
    for plan in plans {
        match &plan.after {
            Some(host) => {
                after.hosts.insert(wire(plan.agent), host.clone());
            }
            None => {
                after.hosts.remove(&wire(plan.agent));
            }
        }
    }
    after
}

/// The entry's revisions once the operation is through: the one before
/// kept until the next operation when it moved, and — while an agent still
/// needs repair — every revision such an agent may load from held.
fn settle_revisions(after: &mut PluginEntry, before: &PluginEntry) {
    let moved = after.revision != before.revision;
    after.previous_revision = moved.then_some(before.revision);
    if after
        .hosts
        .values()
        .any(|host| host.state == HostState::NeedsRepair)
    {
        let mut held = before.held_revisions.clone();
        if moved && !held.contains(&before.revision) {
            held.push(before.revision);
        }
        after.held_revisions = held;
    } else {
        after.held_revisions.clear();
    }
}

fn refused(reason: Reason) -> HarnessPluginInstallResult {
    HarnessPluginInstallResult::refused(vec![reason])
}

/// The record's entry for `item_id`, under its install name.
fn find_entry(
    ctx: &PluginsCtx,
    item_id: &str,
    for_write: bool,
) -> Result<(InstallName, PluginEntry), Reason> {
    let record = if for_write {
        record::load_for_write(ctx)
    } else {
        record::load(ctx)
    }
    .map_err(|error| Reason::new(shared::RECORD_UNREADABLE).detail(error.detail()))?;
    let (key, entry) = record
        .plugins
        .iter()
        .find(|(_, entry)| entry.item_id == item_id)
        .ok_or_else(|| Reason::new(shared::NOT_INSTALLED))?;
    let name = InstallName::parse(key)
        .ok_or_else(|| Reason::new(codes::INSTALL_NAME_INVALID).param("name", key.clone()))?;
    Ok((name, entry.clone()))
}

async fn installed_entry(
    local: &PluginsLocal,
    item_id: &str,
) -> Result<Result<(InstallName, PluginEntry), Reason>, AppCommandError> {
    let (ctx, id) = (local.plugins.clone(), item_id.to_string());
    off_thread(move || find_entry(&ctx, &id, false)).await
}

fn entry_error(reason: Reason) -> AppCommandError {
    if reason.code == shared::NOT_INSTALLED {
        AppCommandError::not_found("This plugin is not installed")
    } else {
        AppCommandError::io_error(reason.detail.unwrap_or(reason.code))
    }
}

/// The item's address now (a rename keeps the id), else the record's.
fn item_ref_of(entry: &PluginEntry, fresh: Option<&Resolved>) -> Result<ItemRef, AppCommandError> {
    if let Some(found) = fresh
        .and_then(|fresh| fresh.r#ref.as_deref())
        .and_then(|address| ItemRef::parse(address).ok())
    {
        return Ok(found);
    }
    Ok(ItemRef::parse(&entry.item_ref)?)
}

/// Why SRN does not vouch now for the revision running on its own, by the
/// fresh snapshot: the item or the revision gone, taken down or withdrawn,
/// no longer approved, or an advisory asking for it to be switched off.
/// `None`: it does. (The update check's guard reads its answers the same
/// way: `guard::not_vouched`.)
fn not_vouched(fresh: &Resolved, revision: u64) -> Option<Reason> {
    if let Some(first) =
        snapshot::item_blocking_as(fresh, revision, Kind::Plugin, codes::NOT_A_PLUGIN)
            .into_iter()
            .next()
    {
        return Some(first);
    }
    let state = fresh.installed.as_ref()?;
    if state.status == VersionStatus::Yanked {
        return Some(Reason::new(shared::YANKED));
    }
    if !state.plugin.as_ref().is_some_and(|plugin| plugin.approved) {
        return Some(Reason::new(codes::NOT_APPROVED).param("revision", revision.to_string()));
    }
    if fresh
        .advisories
        .iter()
        .any(|advisory| advisory.disables(revision))
    {
        return Some(Reason::new(codes::ADVISORY_DISABLE));
    }
    None
}

/// Which members differ between two revisions, by kind and name, then by
/// their files' tree hash (one not known reads as changed).
fn changed_members(from: &[PluginComponent], to: &[PluginComponent]) -> Vec<MemberChange> {
    let same = |a: &PluginComponent, b: &PluginComponent| a.kind == b.kind && a.name == b.name;
    let mut out = Vec::new();
    for component in to {
        match from.iter().find(|old| same(old, component)) {
            None => out.push(MemberChange {
                kind: component.kind,
                name: component.name.clone(),
                change: MemberChangeKind::Added,
            }),
            Some(old) => {
                let unchanged =
                    old.tree_sha256.is_some() && old.tree_sha256 == component.tree_sha256;
                if !unchanged {
                    out.push(MemberChange {
                        kind: component.kind,
                        name: component.name.clone(),
                        change: MemberChangeKind::Changed,
                    });
                }
            }
        }
    }
    for old in from {
        if !to.iter().any(|component| same(old, component)) {
            out.push(MemberChange {
                kind: old.kind,
                name: old.name.clone(),
                change: MemberChangeKind::Removed,
            });
        }
    }
    out
}

// ─── The preflight (under the plugins lock) ─────────────────────────────

/// What an operation finds before it writes: each agent's Experts takeover
/// (with the `ack` when it reaches other agents), the skills preflights in
/// the operation's order, and what stops it.
struct Checked {
    takeovers: BTreeMap<AgentType, Vec<ExpertLink>>,
    /// `skills`, `experts_acks`, `experts_to_*` filled.
    answer: HarnessPluginInstallResult,
    refusals: Vec<Reason>,
    /// The refusals, by the agent they are about.
    refused: BTreeMap<AgentType, Vec<Reason>>,
    unconfirmed: Vec<Reason>,
}

fn unconfirmed_reason(given: bool, agent: AgentType, name: impl Into<String>) -> Reason {
    Reason::new(if given {
        skill_codes::EFFECTS_CHANGED
    } else {
        skill_codes::ACKNOWLEDGEMENT_REQUIRED
    })
    .param("agent", wire(agent))
    .param("name", name)
}

fn check(
    skills: &SkillsCtx,
    owner: &PluginOwner,
    plans: &[AgentPlan],
    names: &[String],
    acks: &BTreeMap<AgentType, BTreeMap<String, String>>,
    experts_acks: &BTreeMap<AgentType, String>,
) -> Checked {
    let puts: Vec<AgentType> = plans
        .iter()
        .filter(|plan| plan.puts())
        .map(|plan| plan.agent)
        .collect();
    let removes: Vec<AgentType> = plans
        .iter()
        .filter(|plan| plan.removes())
        .map(|plan| plan.agent)
        .collect();
    let mut preflights: BTreeMap<AgentType, (OwnedPlan, bool)> = BTreeMap::new();
    for plan in plan_owned_in_turn(skills, owner, &puts, names) {
        preflights.insert(plan.agent, (plan, true));
    }
    for plan in plan_remove_owned_in_turn(skills, owner, &removes) {
        preflights.insert(plan.agent, (plan, false));
    }
    let mut out = Checked {
        takeovers: BTreeMap::new(),
        answer: HarnessPluginInstallResult::new(PluginInstallOutcome::Preflight),
        refusals: Vec::new(),
        refused: BTreeMap::new(),
        unconfirmed: Vec::new(),
    };
    for plan in plans {
        let agent = plan.agent;
        if plan.take_over {
            let links = experts_linked(skills, agent, names);
            if let Some(ack) = experts_ack(agent, &links) {
                match experts_acks.get(&agent) {
                    Some(given) if *given == ack => {}
                    given => {
                        out.unconfirmed
                            .push(unconfirmed_reason(given.is_some(), agent, "experts"))
                    }
                }
                out.answer.experts_acks.insert(agent, ack);
            }
            if !links.is_empty() {
                out.answer.experts_to_take_over.insert(agent, links.clone());
            }
            out.takeovers.insert(agent, links);
        }
        if !plan.give_back.is_empty() {
            out.answer
                .experts_to_give_back
                .insert(agent, plan.give_back.clone());
        }
        if let Some((preflight, put)) = preflights.remove(&agent) {
            let mut refusals: Vec<Reason> = preflight.issues.clone();
            if put {
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
            }
            if !refusals.is_empty() {
                out.refusals.extend(refusals.iter().cloned());
                out.refused.insert(agent, refusals);
            }
            let given = acks.get(&agent);
            for (member, ack) in preflight.acks() {
                match given.and_then(|acks| acks.get(&member)) {
                    Some(sent) if *sent == ack => {}
                    sent => out
                        .unconfirmed
                        .push(unconfirmed_reason(sent.is_some(), agent, member)),
                }
            }
            out.answer.skills.insert(agent, preflight);
        }
    }
    out
}

/// Under the lock: the record still has the entry the plan was made from
/// (all of it: a rollback marks agents without a new `op`), and what the
/// operation finds now.
async fn locked_check(
    local: &PluginsLocal,
    guard: &Arc<PluginsGuard>,
    change: &Change,
) -> Result<Result<Checked, Reason>, AppCommandError> {
    let (plugins, skills) = (local.plugins.clone(), local.skills.ctx.clone());
    let owner = PluginOwner::new(guard, &change.name);
    let (item_id, before) = (change.before.item_id.clone(), change.before.clone());
    let plans = change.plans.clone();
    let names = change.to.skill_names();
    let (acks, experts_acks) = (change.acks.clone(), change.experts_acks.clone());
    locked(guard, move || {
        let (_, entry) = find_entry(&plugins, &item_id, true)?;
        if entry != before {
            return Err(Reason::new(codes::RECORD_CHANGED));
        }
        Ok(check(&skills, &owner, &plans, &names, &acks, &experts_acks))
    })
    .await
}

// ─── Carrying an operation out ──────────────────────────────────────────

/// Everything an operation is.
struct Change {
    action: Action,
    name: InstallName,
    before: PluginEntry,
    /// The entry as it will be once every step went through.
    after: PluginEntry,
    from: RevFiles,
    to: RevFiles,
    /// In the order the steps go.
    plans: Vec<AgentPlan>,
    detects: BTreeMap<AgentType, Detect>,
    /// Skills agents: by member, the `ack`s confirmed.
    acks: BTreeMap<AgentType, BTreeMap<String, String>>,
    experts_acks: BTreeMap<AgentType, String>,
    /// A repair: an agent that fails stays as it was (needing repair), the
    /// others go on; nothing is undone.
    best_effort: bool,
    /// The answer's outcome when it went through.
    done: PluginInstallOutcome,
}

/// The target revision's files to put in place first (none: it is there).
struct Stage {
    files: Vec<PackageFile>,
    /// A folder of that revision that is not what its listing says goes
    /// first (a repair).
    replace: bool,
}

/// A fresh look at the target's snapshot once the revision is in place:
/// what the install's [`fresh_refusal`] checks, for this request.
struct Recheck<'h> {
    harness: &'h Harness,
    request: HarnessPluginInstallRequest,
    native: bool,
    plugin: PluginInfo,
}

/// What the steps work with.
struct Exec<'a> {
    local: &'a PluginsLocal,
    guard: &'a Arc<PluginsGuard>,
    name: &'a InstallName,
    owner: &'a PluginOwner,
    from: &'a RevFiles,
    to: &'a RevFiles,
    detects: &'a BTreeMap<AgentType, Detect>,
}

impl Exec<'_> {
    fn rev(&self, at: At) -> &RevFiles {
        match at {
            At::From => self.from,
            At::To => self.to,
        }
    }

    fn op(&self) -> Op<'_> {
        Op {
            local: self.local,
            guard: self.guard,
            name: self.name,
            owner: self.owner,
            revision: self.to.revision,
            plugin: self.to.plugin.as_ref(),
            detects: self.detects,
        }
    }
}

/// The skill members of the revision at `at`, read (once) from its folder
/// in the store, each file checked against its listing.
async fn members_at(
    ex: &Exec<'_>,
    cache: &mut BTreeMap<u64, Vec<OwnedMember>>,
    at: At,
) -> Result<Result<Vec<OwnedMember>, Vec<Reason>>, AppCommandError> {
    let rev = ex.rev(at);
    if let Some(members) = cache.get(&rev.revision) {
        return Ok(Ok(members.clone()));
    }
    let dir = ex.local.plugins.revision_dir(ex.name, rev.revision);
    let (components, listing) = (rev.components.clone(), rev.listing.clone());
    let read = locked(ex.guard, move || read_members(&dir, &components, &listing)).await?;
    if let Ok(members) = &read {
        cache.insert(rev.revision, members.clone());
    }
    Ok(read)
}

/// One agent's state through the operation.
struct Track {
    agent: AgentType,
    /// Its row in `answer.hosts`.
    index: usize,
    host_name: Option<String>,
    /// The Experts pack's links this operation took out of it.
    taken: Vec<ExpertLink>,
    /// The steps begun, in order: what an undo takes back.
    begun: Vec<Act>,
    /// The Experts pack's links this operation gave back to it.
    given: Vec<ExpertLink>,
    failed: bool,
}

/// Give `links` back (skills lock), into `outcome`. Returns whether it went
/// through, and the links put back now.
async fn give_back(
    ex: &Exec<'_>,
    links: &[ExpertLink],
    outcome: &mut HostOutcome,
    touched: &mut Touched,
) -> Result<(bool, Vec<ExpertLink>), AppCommandError> {
    match give_experts_back(ex.guard, &ex.local.skills.ctx, links.to_vec()).await? {
        Ok(change) => {
            touched.experts(&change);
            outcome.experts_back.extend(change.done.iter().cloned());
            outcome.experts_back.extend(change.already.iter().cloned());
            outcome.experts_left.extend(change.changed.iter().cloned());
            outcome
                .issues
                .extend(change.issues.iter().map(issue_reason));
            let ok = change.ok();
            Ok((ok, if ok { change.done } else { Vec::new() }))
        }
        Err(reason) => {
            outcome.issues.push(reason);
            Ok((false, Vec::new()))
        }
    }
}

/// Whether the act puts the target revision's folder into a host.
fn loads_target(act: &Act) -> bool {
    matches!(
        act,
        Act::NativeInstall(At::To)
            | Act::NativeEnable(At::To)
            | Act::NativeUpdate { to: At::To, .. }
    )
}

/// One step. `acks`: the confirmed ones; `None` (an undo): the
/// operation's own, as the links are now.
#[allow(clippy::too_many_arguments)]
async fn do_act(
    ex: &Exec<'_>,
    members: &mut BTreeMap<u64, Vec<OwnedMember>>,
    track: &mut Track,
    act: Act,
    acks: Option<BTreeMap<String, String>>,
    outcome: &mut HostOutcome,
    touched: &mut Touched,
) -> Result<bool, AppCommandError> {
    let agent = track.agent;
    match act {
        Act::SkillsPut { at, .. } => {
            let list = match members_at(ex, members, at).await? {
                Ok(list) => list,
                Err(issues) => {
                    outcome.issues.extend(issues);
                    return Ok(false);
                }
            };
            let rev = ex.rev(at);
            let (ctx, owner, origin, names) = (
                ex.local.skills.ctx.clone(),
                ex.owner.clone(),
                rev.origin.clone(),
                rev.skill_names(),
            );
            let report = locked(ex.guard, move || {
                let held = ctx
                    .lock_blocking()
                    .map_err(|error| Reason::new(error.code()).detail(error.to_string()))?;
                let acks = acks.unwrap_or_else(|| plan_owned(&ctx, &owner, agent, &names).acks());
                Ok::<_, Reason>(replace_owned(
                    &ctx, &held, &owner, agent, &origin, &list, &acks,
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
                    }
                    Ok(report.ok())
                }
                Err(reason) => {
                    outcome.issues.push(reason);
                    Ok(false)
                }
            }
        }
        Act::SkillsRemove(_) => {
            let (ctx, owner) = (ex.local.skills.ctx.clone(), ex.owner.clone());
            let report = locked(ex.guard, move || {
                let held = ctx
                    .lock_blocking()
                    .map_err(|error| Reason::new(error.code()).detail(error.to_string()))?;
                let acks = acks.unwrap_or_else(|| plan_remove_owned(&ctx, &owner, agent).acks());
                Ok::<_, Reason>(remove_owned(&ctx, &held, &owner, agent, &acks))
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
        native => {
            let Some((host, adapter)) = ex.local.adapter(agent) else {
                outcome
                    .issues
                    .push(ex.local.no_adapter(agent));
                return Ok(false);
            };
            let env = ex.local.env(agent);
            let found;
            let cli = match ex.detects.get(&agent) {
                Some(detect) => detect.cli.as_ref(),
                None => {
                    // Whatever the server's switch says now: what an agent
                    // has is always switched, moved and taken out.
                    found = adapter.detect(&env, &AdapterSwitches::default()).await;
                    found.cli.as_ref()
                }
            };
            let cx = HostCx {
                ctx: &ex.local.plugins,
                env: &env,
                cli,
                lock: ex.guard,
            };
            let host_name = track.host_name.clone();
            let host_name = host_name.as_deref();
            let plugin = |at: At| ex.rev(at).host_plugin(ex.name, host, host_name);
            let done = match native {
                Act::NativeInstall(at) => {
                    match adapter
                        .install(&cx, &ex.rev(at).host_plugin(ex.name, host, None))
                        .await
                    {
                        Ok(name) => {
                            outcome.host_name = Some(name.clone());
                            track.host_name = Some(name);
                            Ok(())
                        }
                        Err(reason) => Err(reason),
                    }
                }
                Act::NativeUninstall { at, .. } => adapter.uninstall(&cx, &plugin(at)).await,
                Act::NativeUpdate { from, to, .. } => {
                    adapter.update(&cx, &plugin(from), &plugin(to)).await
                }
                Act::NativeRepoint { .. } if host == HostId::Codex => Ok(()),
                Act::NativeRepoint { from, to } => {
                    adapter.update(&cx, &plugin(from), &plugin(to)).await
                }
                Act::NativeEnable(at) => adapter.enable(&cx, &plugin(at)).await,
                Act::NativeDisable(at) => adapter.disable(&cx, &plugin(at)).await,
                Act::SkillsPut { .. } | Act::SkillsRemove(_) => unreachable!(),
            };
            match done {
                Ok(()) => Ok(true),
                Err(reason) => {
                    if reason.code == hosts::codes::NAME_CHANGED {
                        outcome.issues.push(
                            Reason::new(codes::REINSTALL_REQUIRED).param("agent", wire(agent)),
                        );
                    }
                    outcome.issues.push(reason);
                    Ok(false)
                }
            }
        }
    }
}

/// The journal's `after` brought up to date, then `work` on the journal.
async fn journaled<T: Send + 'static>(
    guard: &Arc<PluginsGuard>,
    tx: Tx,
    after: &PluginEntry,
    work: impl FnOnce(&mut Tx) -> std::io::Result<T> + Send + 'static,
) -> Result<(Tx, std::io::Result<T>), AppCommandError> {
    let entry = after.clone();
    locked(guard, move || {
        let mut tx = tx;
        let done = tx.set_after(Some(entry)).and_then(|()| work(&mut tx));
        (tx, done)
    })
    .await
}

fn host_mut(after: &mut PluginEntry, agent: AgentType) -> Option<&mut HostEntry> {
    after.hosts.get_mut(&wire(agent))
}

fn add_links(into: &mut Vec<ExpertLink>, links: &[ExpertLink]) {
    for link in links {
        if !into.contains(link) {
            into.push(link.clone());
        }
    }
}

/// Begin the operation's journal and put the target revision in place.
async fn open(
    local: &PluginsLocal,
    guard: &Arc<PluginsGuard>,
    change: &Change,
    stage: Option<Stage>,
) -> Result<Result<Tx, std::io::Error>, AppCommandError> {
    let (ctx, held, name) = (local.plugins.clone(), guard.clone(), change.name.clone());
    let (action, after) = (change.action, change.after.clone());
    let (revision, listing) = (change.to.revision, change.to.listing.clone());
    locked(guard, move || {
        let mut tx = Tx::begin(&ctx, &held, action, &name, Some(after))?;
        if let Some(stage) = stage {
            let dir = ctx.revision_dir(&name, revision);
            let staged = (|| {
                // Never through a link out of the store.
                let parent = ctx.plugin_dir(&name);
                if stage.replace
                    && std::fs::symlink_metadata(&parent).is_ok_and(|meta| !meta.is_dir())
                {
                    return Err(std::io::Error::other(format!(
                        "{} is not a plain folder",
                        parent.display()
                    )));
                }
                if stage.replace
                    && std::fs::symlink_metadata(&dir).is_ok()
                    && store::verify_revision(&dir, &listing).is_err()
                {
                    store::discard(&ctx, &dir, "repair")?;
                }
                tx.stage(revision, &listing, &stage.files)
            })();
            if let Err(error) = staged {
                // Nothing of any agent's touched.
                let _ = tx.rollback(&BTreeSet::new());
                return Err(error);
            }
        }
        Ok(tx)
    })
    .await
}

/// Give the operation up before any agent is touched.
async fn abandon(
    guard: &Arc<PluginsGuard>,
    tx: Tx,
    mut stop: HarnessPluginInstallResult,
) -> Result<HarnessPluginInstallResult, AppCommandError> {
    if let Err(error) = locked(guard, move || tx.rollback(&BTreeSet::new())).await? {
        stop.issues.push(io_reason(&error));
    }
    Ok(stop)
}

/// Journal, stage, check once more, then every agent's steps (see the
/// module docs), the record and the announcement.
async fn carry_out(
    local: &PluginsLocal,
    emitter: &EventEmitter,
    guard: Arc<PluginsGuard>,
    change: Change,
    takeovers: BTreeMap<AgentType, Vec<ExpertLink>>,
    stage: Option<Stage>,
    recheck: Option<Recheck<'_>>,
) -> Result<HarnessPluginInstallResult, AppCommandError> {
    let name_text = change.name.to_string();
    let mut tx = match open(local, &guard, &change, stage).await? {
        Ok(tx) => tx,
        Err(error) => {
            return Ok(HarnessPluginInstallResult {
                issues: vec![io_reason(&error)],
                name: Some(name_text),
                ..HarnessPluginInstallResult::new(PluginInstallOutcome::Failed)
            })
        }
    };

    // The last checks before any agent is touched.
    if let Some(recheck) = recheck {
        let fresh = harness_skills::resolve_one(
            recheck.harness,
            &change.before.item_id,
            change.to.revision,
        )
        .await;
        let stop = match &fresh {
            Ok(fresh) => fresh_refusal(fresh, &recheck.request, recheck.native, &recheck.plugin),
            Err(_) => None,
        };
        if let Err(error) = fresh {
            let undone = locked(&guard, move || tx.rollback(&BTreeSet::new())).await?;
            if let Err(undo) = undone {
                tracing::warn!("[Harness plugins] the staged update could not be cleared: {undo}");
            }
            return Err(error.into());
        }
        if let Some(mut stop) = stop {
            stop.name = Some(name_text);
            return abandon(&guard, tx, stop).await;
        }
    }
    let owner = PluginOwner::new(&guard, &change.name);
    let ex = Exec {
        local,
        guard: &guard,
        name: &change.name,
        owner: &owner,
        from: &change.from,
        to: &change.to,
        detects: &change.detects,
    };
    let mut members: BTreeMap<u64, Vec<OwnedMember>> = BTreeMap::new();
    let mut stop = None;
    // OpenCode loads code from the folder: it must have some.
    if let Some(plugin) = &change.to.plugin {
        let dir = local.plugins.revision_dir(&change.name, change.to.revision);
        let opencode: Vec<AgentType> = change
            .plans
            .iter()
            .filter(|plan| HostId::for_agent(plan.agent) == Some(HostId::OpenCode))
            .filter(|plan| plan.acts.iter().any(loads_target))
            .map(|plan| plan.agent)
            .collect();
        if !opencode.is_empty() {
            let (plugin, dir) = (plugin.clone(), dir.clone());
            if let Err(why) =
                locked(&guard, move || OpenCodeAdapter::installable(&plugin, &dir)).await?
            {
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
    // What a host loads in place is exactly what SRN vouched for.
    if stop.is_none()
        && change
            .plans
            .iter()
            .any(|plan| plan.acts.iter().any(loads_target))
    {
        let dir = local.plugins.revision_dir(&change.name, change.to.revision);
        let listing = change.to.listing.clone();
        if let Err(problems) =
            locked(&guard, move || store::verify_revision(&dir, &listing)).await?
        {
            let shown: Vec<String> = problems.iter().take(5).map(ToString::to_string).collect();
            stop = Some(HarnessPluginInstallResult {
                issues: vec![Reason::new(codes::REVISION_MODIFIED)
                    .param("revision", change.to.revision.to_string())
                    .detail(shown.join("; "))],
                ..HarnessPluginInstallResult::new(PluginInstallOutcome::InvalidPackage)
            });
        }
    }
    // The members' files, before any agent gets them.
    if stop.is_none() && change.plans.iter().any(AgentPlan::puts) {
        if let Err(issues) = members_at(&ex, &mut members, At::To).await? {
            stop = Some(HarnessPluginInstallResult {
                issues,
                ..HarnessPluginInstallResult::new(PluginInstallOutcome::InvalidPackage)
            });
        }
    }
    if let Some(mut stop) = stop {
        stop.name = Some(name_text);
        return abandon(&guard, tx, stop).await;
    }

    let mut answer = HarnessPluginInstallResult::new(change.done);
    answer.name = Some(name_text);
    answer.revision = Some(change.to.revision);
    let mut touched = Touched::default();
    let mut after = change.after.clone();
    let mut tracks: Vec<Track> = Vec::new();
    for plan in &change.plans {
        let mode = plan.order_mode();
        answer.hosts.push(HostOutcome::new(plan.agent, mode));
        let host_name = plan.before.as_ref().and_then(|host| host.host_name.clone());
        answer.hosts.last_mut().unwrap().host_name = host_name.clone();
        tracks.push(Track {
            agent: plan.agent,
            index: answer.hosts.len() - 1,
            host_name,
            taken: Vec::new(),
            begun: Vec::new(),
            given: Vec::new(),
            failed: false,
        });
    }
    let mut failed = false;
    let mut journal_error = None;
    let best_effort = change.best_effort;
    // An agent of a repair that fails stays as it was.
    let give_up = |after: &mut PluginEntry, plan: &AgentPlan| match (
        host_mut(after, plan.agent),
        &plan.before,
    ) {
        (Some(host), Some(before)) => {
            let experts = host.experts.clone();
            *host = before.clone();
            add_links(&mut host.experts, &experts);
        }
        (_, Some(before)) => {
            after.hosts.insert(wire(plan.agent), before.clone());
        }
        _ => {}
    };

    // The Experts pack's links first, for every agent: each written down
    // before anything moves, so that a crash midway gives them back.
    for (plan, track) in change.plans.iter().zip(tracks.iter_mut()) {
        let takeover = takeovers.get(&plan.agent).cloned().unwrap_or_default();
        if !plan.take_over || takeover.is_empty() {
            continue;
        }
        let mode = plan.order_mode();
        if let Some(host) = host_mut(&mut after, plan.agent) {
            add_links(&mut host.experts, &takeover);
        }
        let step_wire = wire(plan.agent);
        let (back, planned) = journaled(&guard, tx, &after, move |tx| {
            tx.step_planned(&step_wire, mode, "take_over")
        })
        .await?;
        tx = back;
        let index = match planned {
            Ok(index) => index,
            Err(error) => {
                journal_error = Some(error);
                failed = true;
                break;
            }
        };
        let outcome = &mut answer.hosts[track.index];
        let mut started = Started {
            agent: plan.agent,
            mode,
            host_name: None,
            experts: Vec::new(),
            installing: false,
        };
        let ok = take_step(
            &ex.op(),
            takeover.clone(),
            &mut started,
            outcome,
            &mut touched,
        )
        .await?;
        track.taken = started.experts.clone();
        if let Some(host) = host_mut(&mut after, plan.agent) {
            host.experts.retain(|link| !takeover.contains(link));
            add_links(&mut host.experts, &track.taken);
        }
        if !ok {
            outcome.status = HostStepStatus::Failed;
            answer.issues.push(
                Reason::new(codes::HOST_STEP_FAILED)
                    .param("agent", wire(plan.agent))
                    .param("step", "take_over"),
            );
            if best_effort {
                track.failed = true;
                give_up(&mut after, plan);
                if let Some(host) = host_mut(&mut after, plan.agent) {
                    add_links(&mut host.experts, &track.taken);
                }
            } else {
                failed = true;
                break;
            }
        }
        let (back, done) = journaled(&guard, tx, &after, move |tx| tx.step_done(index)).await?;
        tx = back;
        if let Err(error) = done {
            journal_error = Some(error);
            failed = true;
            break;
        }
    }

    // Then every agent's steps, one by one.
    'agents: for (plan, track) in change.plans.iter().zip(tracks.iter_mut()) {
        if failed {
            break;
        }
        if track.failed {
            continue;
        }
        for act in &plan.acts {
            let act = *act;
            let step_wire = wire(plan.agent);
            let (back, planned) = journaled(&guard, tx, &after, move |tx| {
                tx.step_planned(&step_wire, act.mode(), act.label())
            })
            .await?;
            tx = back;
            let index = match planned {
                Ok(index) => index,
                Err(error) => {
                    journal_error = Some(error);
                    failed = true;
                    break 'agents;
                }
            };
            track.begun.push(act);
            let acks = change.acks.get(&plan.agent).cloned().unwrap_or_default();
            let outcome = &mut answer.hosts[track.index];
            let ok = do_act(
                &ex,
                &mut members,
                track,
                act,
                Some(acks),
                outcome,
                &mut touched,
            )
            .await?;
            if matches!(act, Act::NativeInstall(_)) {
                if let Some(host) = host_mut(&mut after, plan.agent) {
                    host.host_name = track.host_name.clone();
                }
            }
            if !ok {
                outcome.status = HostStepStatus::Failed;
                answer.issues.push(
                    Reason::new(codes::HOST_STEP_FAILED)
                        .param("agent", wire(plan.agent))
                        .param("step", act.label()),
                );
                if best_effort {
                    track.failed = true;
                    give_up(&mut after, plan);
                    if let Some(host) = host_mut(&mut after, plan.agent) {
                        add_links(&mut host.experts, &track.taken);
                    }
                } else {
                    failed = true;
                }
            }
            let (back, done) = journaled(&guard, tx, &after, move |tx| tx.step_done(index)).await?;
            tx = back;
            if let Err(error) = done {
                journal_error = Some(error);
                failed = true;
                break 'agents;
            }
            if failed {
                break 'agents;
            }
            if track.failed {
                continue 'agents;
            }
        }
    }

    // A repair checks what each host has now.
    if !failed && best_effort {
        for (plan, track) in change.plans.iter().zip(tracks.iter_mut()) {
            // Only what is to run is checked (one left off has no entry in
            // OpenCode, say).
            let active = plan
                .after
                .as_ref()
                .is_some_and(|host| host.state == HostState::Active);
            if track.failed || plan.order_mode() != HostMode::Native || !active {
                continue;
            }
            let Some((host, adapter)) = local.adapter(plan.agent) else {
                continue;
            };
            let env = local.env(plan.agent);
            let found;
            let cli = match change.detects.get(&plan.agent) {
                Some(detect) => detect.cli.as_ref(),
                None => {
                    found = adapter.detect(&env, &AdapterSwitches::default()).await;
                    found.cli.as_ref()
                }
            };
            let cx = HostCx {
                ctx: &local.plugins,
                env: &env,
                cli,
                lock: &guard,
            };
            let verify = adapter
                .verify(
                    &cx,
                    &change
                        .to
                        .host_plugin(&change.name, host, track.host_name.as_deref()),
                )
                .await;
            if !verify.ok() {
                let outcome = &mut answer.hosts[track.index];
                outcome.status = HostStepStatus::Failed;
                outcome.issues.extend(verify.problems);
                track.failed = true;
                give_up(&mut after, plan);
                if let Some(host) = host_mut(&mut after, plan.agent) {
                    add_links(&mut host.experts, &track.taken);
                    host.host_name = track.host_name.clone();
                }
            }
        }
    }

    // The Experts pack's links of names no longer provided, back.
    if !failed {
        for (plan, track) in change.plans.iter().zip(tracks.iter_mut()) {
            if plan.give_back.is_empty() || track.failed {
                continue;
            }
            let mode = plan.order_mode();
            let step_wire = wire(plan.agent);
            let (back, planned) = journaled(&guard, tx, &after, move |tx| {
                tx.step_planned(&step_wire, mode, "give_back")
            })
            .await?;
            tx = back;
            let index = match planned {
                Ok(index) => index,
                Err(error) => {
                    journal_error = Some(error);
                    failed = true;
                    break;
                }
            };
            let outcome = &mut answer.hosts[track.index];
            let (ok, given) = give_back(&ex, &plan.give_back, outcome, &mut touched).await?;
            track.given = given;
            // Those not back that this plugin's own members still hold the
            // place of (an agent left out, say) are kept, to go back later;
            // after a failure, every one still to go back.
            let keep = if ok {
                let left: Vec<ExpertLink> = plan
                    .give_back
                    .iter()
                    .filter(|link| outcome.experts_left.contains(link))
                    .cloned()
                    .collect();
                held_back(&ex.op(), left).await?
            } else {
                still_to_give_back(&ex.op(), &plan.give_back, outcome).await?
            };
            if !keep.is_empty() {
                match host_mut(&mut after, plan.agent) {
                    Some(host) => add_links(&mut host.experts, &keep),
                    None if !ok => {
                        // The agent leaving keeps its entry for them,
                        // needing repair.
                        if let Some(before) = &plan.before {
                            let mut host = before.clone();
                            host.mark_needs_repair([]);
                            host.experts = keep;
                            after.hosts.insert(wire(plan.agent), host);
                            answer.needs_repair.push(plan.agent);
                        }
                    }
                    None => {
                        let keeper = after.hosts.keys().next().cloned();
                        carry_experts(&mut after.hosts, keeper.as_ref(), keep);
                    }
                }
            }
            let (back, done) = journaled(&guard, tx, &after, move |tx| tx.step_done(index)).await?;
            tx = back;
            if let Err(error) = done {
                journal_error = Some(error);
                failed = true;
                break;
            }
        }
    }

    if !failed {
        settle_revisions(&mut after, &change.before);
        // No agent left (a repair that finished an uninstall): the entry
        // goes.
        let (back, committed) = if after.hosts.is_empty() {
            locked(&guard, move || {
                let mut tx = tx;
                let done = tx.set_after(None).and_then(|()| tx.commit());
                (tx, done)
            })
            .await?
        } else {
            journaled(&guard, tx, &after, |tx| tx.commit()).await?
        };
        tx = back;
        match committed {
            Ok(()) => {
                match locked(&guard, move || tx.finish()).await? {
                    Ok(problems) => answer.problems = problems,
                    Err(error) => answer.problems.push(error.to_string()),
                }
                drop(guard);
                for track in &tracks {
                    if track.failed {
                        answer.needs_repair.push(track.agent);
                    }
                }
                answer.needs_repair.sort();
                answer.needs_repair.dedup();
                if !answer.needs_repair.is_empty() {
                    answer
                        .issues
                        .push(needs_repair_reason(&answer.needs_repair));
                }
                announce(
                    emitter,
                    &change.before.item_id,
                    change.plans.iter().map(|plan| plan.agent),
                    &touched,
                    true,
                );
                return Ok(answer);
            }
            Err(error) => journal_error = Some(error),
        }
    }
    if let Some(error) = journal_error {
        answer.issues.push(io_reason(&error));
    }

    // Undone: the Experts links given back out again, every step begun
    // (latest first), then the Experts links taken back in.
    let (back, marked) = journaled(&guard, tx, &after, |tx| tx.undoing()).await?;
    tx = back;
    if let Err(error) = marked {
        answer.issues.push(io_reason(&error));
    }
    let mut needs_repair: BTreeSet<AgentType> = BTreeSet::new();
    if best_effort {
        // A repair is not undone: every agent it touched needs repair still,
        // keeping the links it took.
        for (plan, track) in change.plans.iter().zip(tracks.iter()) {
            if track.begun.is_empty() && track.taken.is_empty() && track.given.is_empty() {
                continue;
            }
            needs_repair.insert(track.agent);
            let mut kept = plan
                .before
                .as_ref()
                .map(|host| host.experts.clone())
                .unwrap_or_default();
            add_links(&mut kept, &track.taken);
            kept.retain(|link| !track.given.contains(link));
            if let Some(host) = host_mut(&mut after, track.agent) {
                host.experts = kept;
            }
        }
    } else {
        // The members the undo puts back go where these links are now.
        for track in tracks.iter().rev() {
            if track.given.is_empty() {
                continue;
            }
            match take_experts(&guard, &local.skills.ctx, track.given.clone()).await? {
                Ok(change) => {
                    touched.experts(&change);
                    if !change.ok() {
                        needs_repair.insert(track.agent);
                    }
                }
                Err(_) => {
                    needs_repair.insert(track.agent);
                }
            }
        }
        for track in tracks.iter_mut().rev() {
            let mut outcome = answer.hosts[track.index].clone();
            let begun: Vec<Act> = track.begun.iter().rev().copied().collect();
            'undo: for act in begun {
                let Some(undo) = act.undo() else {
                    needs_repair.insert(track.agent);
                    break 'undo;
                };
                for undo in undo {
                    if !do_act(
                        &ex,
                        &mut members,
                        track,
                        undo,
                        None,
                        &mut outcome,
                        &mut touched,
                    )
                    .await?
                    {
                        needs_repair.insert(track.agent);
                        break 'undo;
                    }
                }
            }
            if needs_repair.contains(&track.agent) {
                outcome.status = HostStepStatus::NeedsRepair;
            }
            answer.hosts[track.index] = outcome;
        }
        let mut left = Vec::new();
        for (plan, track) in change.plans.iter().zip(tracks.iter()) {
            let mut outcome = answer.hosts[track.index].clone();
            let mut kept = plan
                .before
                .as_ref()
                .map(|host| host.experts.clone())
                .unwrap_or_default();
            if !needs_repair.contains(&track.agent) {
                let (ok, _) = give_back(&ex, &track.taken, &mut outcome, &mut touched).await?;
                if ok {
                    left.extend(
                        track
                            .taken
                            .iter()
                            .filter(|link| outcome.experts_left.contains(link))
                            .cloned(),
                    );
                    if outcome.status != HostStepStatus::Failed
                        && (!track.begun.is_empty() || !track.taken.is_empty())
                    {
                        outcome.status = HostStepStatus::Undone;
                    }
                } else {
                    needs_repair.insert(track.agent);
                    outcome.status = HostStepStatus::NeedsRepair;
                    let still = still_to_give_back(&ex.op(), &track.taken, &outcome).await?;
                    add_links(&mut kept, &still);
                    if let Some(host) = host_mut(&mut after, track.agent) {
                        host.experts = kept;
                    }
                }
            } else {
                // Marked: it keeps what it had, and what was taken now.
                add_links(&mut kept, &track.taken);
                if let Some(host) = host_mut(&mut after, track.agent) {
                    host.experts = kept;
                }
            }
            answer.hosts[track.index] = outcome;
        }
        if !needs_repair.is_empty() {
            let held = held_back(&ex.op(), left).await?;
            let keeper = needs_repair.iter().next().map(|agent| wire(*agent));
            carry_experts(&mut after.hosts, keeper.as_ref(), held);
        }
    }
    let repair: BTreeSet<String> = needs_repair.iter().map(|agent| wire(*agent)).collect();
    let (back, kept) = journaled(&guard, tx, &after, |_| Ok(())).await?;
    tx = back;
    if let Err(error) = kept {
        answer.issues.push(io_reason(&error));
    }
    match locked(&guard, move || tx.rollback(&repair)).await? {
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
            answer.needs_repair = tracks
                .iter()
                .filter(|track| !track.begun.is_empty() || !track.taken.is_empty())
                .map(|track| track.agent)
                .collect();
        }
    }
    if !answer.needs_repair.is_empty() {
        answer
            .issues
            .push(needs_repair_reason(&answer.needs_repair));
    }
    answer.outcome = PluginInstallOutcome::Failed;
    let marked = !answer.needs_repair.is_empty();
    drop(guard);
    announce(
        emitter,
        &change.before.item_id,
        answer.needs_repair.iter().copied(),
        &touched,
        marked,
    );
    Ok(answer)
}

fn needs_repair_reason(agents: &[AgentType]) -> Reason {
    Reason::new(codes::NEEDS_REPAIR).param(
        "agents",
        agents
            .iter()
            .map(|agent| wire(*agent))
            .collect::<Vec<_>>()
            .join(","),
    )
}

/// Take the lock, check, answer a preflight or what stops the call, else
/// carry the change out. A repair leaves out the agents its preflight
/// refuses (they stay marked) and does the others.
#[allow(clippy::too_many_arguments)]
async fn checked_carry_out(
    local: &PluginsLocal,
    emitter: &EventEmitter,
    mut change: Change,
    preflight: bool,
    preflight_answer: impl FnOnce(&mut HarnessPluginInstallResult),
    gate: impl FnOnce() -> Option<HarnessPluginInstallResult>,
    stage: Option<Stage>,
    recheck: Option<Recheck<'_>>,
) -> Result<HarnessPluginInstallResult, AppCommandError> {
    let name = change.name.to_string();
    let guard = match local.plugins.lock().await {
        Ok(guard) => Arc::new(guard),
        Err(error) => {
            return Ok(HarnessPluginInstallResult {
                issues: vec![Reason::new(error.code()).detail(error.to_string())],
                name: Some(name),
                ..HarnessPluginInstallResult::new(PluginInstallOutcome::Busy)
            })
        }
    };
    let mut checked = match locked_check(local, &guard, &change).await? {
        Ok(checked) => checked,
        Err(reason) => {
            let mut answer = refused(reason);
            answer.name = Some(name);
            return Ok(answer);
        }
    };
    // A repair: the agents refused stay marked; the others are checked
    // again without them (the links each would find, the `ack`s, are those
    // of the agents done before it).
    let mut skipped: Vec<Reason> = Vec::new();
    let mut left_out: Vec<AgentType> = Vec::new();
    if change.best_effort && !checked.refused.is_empty() {
        for agent in checked.refused.keys() {
            change.plans.retain(|plan| plan.agent != *agent);
            if let Some(before) = change.before.hosts.get(&wire(*agent)) {
                change.after.hosts.insert(wire(*agent), before.clone());
            }
            left_out.push(*agent);
        }
        skipped = checked.refusals.clone();
        if !change.plans.is_empty() {
            checked = match locked_check(local, &guard, &change).await? {
                Ok(checked) => checked,
                Err(reason) => {
                    let mut answer = refused(reason);
                    answer.name = Some(name);
                    return Ok(answer);
                }
            };
        }
    }
    let mut answer = checked.answer;
    answer.name = Some(name);
    answer.revision = Some(change.to.revision);
    if preflight {
        answer.issues = skipped;
        answer.issues.extend(checked.refusals);
        preflight_answer(&mut answer);
        return Ok(answer);
    }
    if change.plans.is_empty() || !checked.refusals.is_empty() {
        answer.outcome = PluginInstallOutcome::Refused;
        answer.issues = skipped;
        answer.issues.extend(checked.refusals);
        return Ok(answer);
    }
    if !checked.unconfirmed.is_empty() {
        answer.outcome = PluginInstallOutcome::AcknowledgementRequired;
        answer.issues = checked.unconfirmed;
        return Ok(answer);
    }
    if let Some(mut stop) = gate() {
        stop.name = answer.name.take();
        return Ok(stop);
    }
    let mut done = carry_out(
        local,
        emitter,
        guard,
        change,
        checked.takeovers,
        stage,
        recheck,
    )
    .await?;
    if !left_out.is_empty() {
        done.issues
            .retain(|reason| reason.code != codes::NEEDS_REPAIR);
        done.issues.extend(skipped);
        done.needs_repair.extend(left_out);
        done.needs_repair.sort();
        done.needs_repair.dedup();
        done.issues.push(needs_repair_reason(&done.needs_repair));
    }
    Ok(done)
}

// ─── Update ─────────────────────────────────────────────────────────────

/// What an update finds before the lock: the revisions, the hosts.
struct UpdatePrep {
    name: InstallName,
    entry: PluginEntry,
    latest: Option<Rev>,
    full: Option<Rev>,
    not_full: Option<crate::harness::types::NotFull>,
    item_status: crate::harness::types::ItemStatus,
    whole: Vec<Reason>,
    limits: harness_skills::PackageLimits,
    detects: BTreeMap<AgentType, Detect>,
    /// Native agents whose host cannot take the target whole: their skills
    /// only from now on.
    fallbacks: BTreeMap<AgentType, Reason>,
    /// Why nothing can be updated (an agent's host gone, …).
    blocking: Vec<Reason>,
    /// An agent has it as a plugin (one going on with its skills only
    /// included): the target is `full`, as the install chose it.
    any_native: bool,
    /// An agent keeps it as a plugin once updated: what runs on its own is
    /// agreed to.
    native_after: bool,
    /// The installed revision's plugin part, when it could be read.
    from_plugin: Option<PluginInfo>,
}

impl UpdatePrep {
    fn target(&self) -> Option<&Rev> {
        if self.any_native {
            self.full.as_ref()
        } else {
            self.latest.as_ref()
        }
    }

    fn from(&self) -> RevFiles {
        RevFiles::recorded(&self.entry, self.from_plugin.clone())
    }

    fn to(&self, state_sha256: &str) -> Option<RevFiles> {
        let target = self.target()?;
        let plugin = target.plugin()?;
        Some(RevFiles::of_info(&target.info, plugin, state_sha256))
    }

    /// The exec_sha256 the target asks agreement to.
    fn target_exec(&self) -> Option<String> {
        self.target().and_then(Rev::exec)
    }

    fn runs_on_its_own(&self) -> bool {
        self.target()
            .and_then(Rev::plugin)
            .is_some_and(PluginInfo::runs_on_its_own)
    }

    /// Every agent's part.
    fn plans(&self, skills: &SkillsCtx, to: &RevFiles) -> Vec<AgentPlan> {
        let moving = to.revision != self.entry.revision;
        let names = to.skill_names();
        let mut plans = Vec::new();
        for (agent_wire, host) in &self.entry.hosts {
            let Some(agent) = AgentType::from_wire(agent_wire) else {
                continue;
            };
            let mut plan = AgentPlan::new(agent, Some(host.clone()));
            let mut after = host.clone();
            if host.state == HostState::NeedsRepair {
                plan.action = UpdateAction::NeedsRepair;
                plans.push(plan);
                continue;
            }
            let fallback = self.fallbacks.get(&agent).cloned();
            match (host.mode, fallback) {
                (HostMode::Native, Some(why)) => {
                    plan.acts.push(Act::NativeUninstall {
                        at: At::From,
                        was_on: host.state == HostState::Active,
                    });
                    // Switched off by the user: its skills stay off too.
                    if host.state != HostState::DisabledByUser {
                        plan.acts.push(Act::SkillsPut {
                            at: At::To,
                            undo_to: None,
                        });
                        after.state = HostState::Active;
                        plan.take_over = true;
                    }
                    after.mode = HostMode::Skills;
                    after.host_name = None;
                    plan.action = UpdateAction::ToSkills;
                    plan.why_not = Some(why);
                }
                (HostMode::Native, None) => match &host.state {
                    HostState::Suspended { .. } => {
                        // Off in its host: moved to the target (also when
                        // it is the same: a repair may have only repointed
                        // it), then on.
                        plan.acts.push(Act::NativeUpdate {
                            from: At::From,
                            to: At::To,
                            undo_off: true,
                        });
                        plan.acts.push(Act::NativeEnable(At::To));
                        after.state = HostState::Active;
                        plan.take_over = true;
                        plan.action = UpdateAction::Resume;
                    }
                    state if moving => {
                        plan.acts.push(Act::NativeUpdate {
                            from: At::From,
                            to: At::To,
                            undo_off: false,
                        });
                        plan.take_over = *state == HostState::Active;
                        plan.action = UpdateAction::Update;
                    }
                    _ => {}
                },
                (HostMode::Skills, _) => match &host.state {
                    HostState::Suspended { .. } => {
                        plan.acts.push(Act::SkillsPut {
                            at: At::To,
                            undo_to: None,
                        });
                        after.state = HostState::Active;
                        plan.take_over = true;
                        plan.action = UpdateAction::Resume;
                    }
                    HostState::Active if moving => {
                        plan.acts.push(Act::SkillsPut {
                            at: At::To,
                            undo_to: Some(At::From),
                        });
                        plan.take_over = true;
                        plan.action = UpdateAction::Update;
                    }
                    HostState::DisabledByUser if moving => {
                        plan.action = UpdateAction::RecordOnly;
                    }
                    _ => {}
                },
            }
            if after.mode == HostMode::Skills {
                after.skills = names.clone();
            }
            if moving || plan.action == UpdateAction::ToSkills {
                plan.give_back = host
                    .experts
                    .iter()
                    .filter(|link| !names.contains(&link.name))
                    .cloned()
                    .collect();
                after.experts.retain(|link| !plan.give_back.contains(link));
            }
            plan.after = Some(after);
            plans.push(plan);
        }
        sort_plans(skills, &mut plans);
        plans
    }

    /// Nothing to do: every agent has the target as it should.
    fn up_to_date(&self, plans: &[AgentPlan]) -> bool {
        self.target()
            .is_some_and(|target| target.revision() == self.entry.revision)
            && plans.iter().all(|plan| plan.acts.is_empty())
    }

    /// The user must agree to what runs on its own again: as a plugin
    /// somewhere, something runs, and it is not what they agreed to — or an
    /// agent Codeg turned off runs it again.
    fn needs_consent(&self, plans: &[AgentPlan]) -> bool {
        if !self.native_after || !self.runs_on_its_own() {
            return false;
        }
        let agreed = self
            .entry
            .consent
            .as_ref()
            .map(|consent| consent.exec.clone());
        let resumes = plans.iter().any(|plan| {
            plan.action == UpdateAction::Resume && plan.order_mode() == HostMode::Native
        });
        agreed.is_none() || agreed != self.target_exec() || resumes
    }

    /// Why the update cannot go on: an agent's host, or — while any agent
    /// has it as a plugin — why nothing may be installed whole; else no
    /// latest revision at all.
    fn blocking(&self) -> Vec<Reason> {
        let mut out = self.blocking.clone();
        if self.any_native {
            push_unique(&mut out, self.whole.clone());
        } else if self.latest.is_none() {
            out.push(
                Reason::new(shared::ITEM_UNAVAILABLE)
                    .param("status", snapshot::wire(&self.item_status)),
            );
        }
        out
    }
}

async fn prepare_update(
    local: &PluginsLocal,
    harness: &Harness,
    name: InstallName,
    entry: PluginEntry,
) -> Result<UpdatePrep, AppCommandError> {
    harness.ensure_enabled()?;
    let current = harness_skills::resolve_one(harness, &entry.item_id, entry.revision).await?;
    let item_ref = item_ref_of(&entry, Some(&current))?;
    let config = harness.config().await?;
    let switches = AdapterSwitches::from_config(&config);
    let limits = package::limits_from_config(&config);
    let latest_at = current.latest.as_ref().map(|latest| latest.revision);
    let latest = match latest_at.filter(|revision| *revision > 0) {
        Some(revision) => Some(read_rev(harness, &item_ref, revision).await?),
        None => None,
    };
    let full_at = latest
        .as_ref()
        .and_then(Rev::state)
        .and_then(|state| state.plugin.as_ref())
        .and_then(|plugin| plugin.full.as_ref())
        .map(|full| full.revision);
    let full = match (full_at, &latest) {
        (Some(revision), Some(latest)) if revision == latest.revision() => Some(latest.clone()),
        (Some(revision), _) => Some(read_rev(harness, &item_ref, revision).await?),
        (None, _) => None,
    };
    let not_full = latest
        .as_ref()
        .and_then(Rev::plugin)
        .and_then(|plugin| plugin.not_full);
    let whole = whole_blocking(full.as_ref(), not_full, harness, &limits);
    let from_plugin = [latest.as_ref(), full.as_ref()]
        .into_iter()
        .flatten()
        .find(|rev| rev.revision() == entry.revision)
        .and_then(|rev| rev.plugin().cloned());
    let from_plugin = match from_plugin {
        Some(plugin) => Some(plugin),
        None => harness
            .install_info(&item_ref, entry.revision)
            .await
            .ok()
            .and_then(|info| info.plugin),
    };

    // Each agent that has it as a plugin: can its host take `full` whole?
    let mut detects = BTreeMap::new();
    let mut fallbacks = BTreeMap::new();
    let mut blocking = Vec::new();
    let mut any_native = false;
    let mut native_after = false;
    for (agent_wire, host) in &entry.hosts {
        let Some(agent) = AgentType::from_wire(agent_wire) else {
            // An agent this Codeg does not know (a newer one's): it may
            // load the revision there is, which an update would let go.
            blocking.push(
                Reason::new(skill_codes::AGENT_UNSUPPORTED).param("agent", agent_wire.clone()),
            );
            continue;
        };
        if host.mode != HostMode::Native {
            continue;
        }
        any_native = true;
        if host.state == HostState::NeedsRepair {
            // Repaired to the record's revision later, as a plugin.
            native_after = true;
            continue;
        }
        let Some((host_id, adapter)) = local.adapter(agent) else {
            blocking.push(local.no_adapter(agent));
            continue;
        };
        let detect = adapter.detect(&local.env(agent), &switches).await;
        if detect.cli.is_none() {
            blocking.push(
                Reason::new(codes::NATIVE_UNAVAILABLE)
                    .param("agent", wire(agent))
                    .param("why", hosts::codes::HOST_NOT_FOUND),
            );
            detects.insert(agent, detect);
            continue;
        }
        let why = if whole.is_empty() {
            let entry_ok = host_id == HostId::OpenCode
                && match &full {
                    Some(full) => opencode_entry(harness, &local.skills.raw_origin, full).await,
                    None => false,
                };
            native_why_not(host_id, &detect, full.as_ref(), &[], entry_ok)
        } else {
            None
        };
        match why {
            Some(why) if local.skills_ok(agent) => {
                fallbacks.insert(agent, why);
            }
            Some(why) => {
                let mut reason = Reason::new(codes::NATIVE_UNAVAILABLE)
                    .param("agent", wire(agent))
                    .param("why", why.code.clone());
                if let Some(detail) = why.detail {
                    reason = reason.detail(detail);
                }
                blocking.push(reason);
                native_after = true;
            }
            None => native_after = true,
        }
        detects.insert(agent, detect);
    }
    Ok(UpdatePrep {
        name,
        entry,
        latest,
        full,
        not_full,
        item_status: current.status,
        whole,
        limits,
        detects,
        fallbacks,
        blocking,
        any_native,
        native_after,
        from_plugin,
    })
}

/// Everything the update prompt shows: from which revision to which, what
/// changed, each agent's part, what the user must agree to. Fails only when
/// the plugin is not installed or the catalog cannot be asked.
pub(crate) async fn plan_update(
    local: &PluginsLocal,
    harness: &Harness,
    item_id: &str,
) -> Result<HarnessPluginUpdatePlan, AppCommandError> {
    harness.ensure_enabled()?;
    let (name, entry) = installed_entry(local, item_id)
        .await?
        .map_err(entry_error)?;
    let prep = prepare_update(local, harness, name, entry).await?;
    let target = prep.target();
    let state_sha256 = target
        .and_then(Rev::state)
        .and_then(|state| state.state_sha256.clone());
    let to = prep.to(state_sha256.as_deref().unwrap_or_default());
    let from = prep.from();
    let plans = match &to {
        Some(to) => prep.plans(&local.skills.ctx, to),
        None => Vec::new(),
    };
    let mut blocking = prep.blocking();
    if let Some(target) = target {
        let mut own = revision_blocking(target, harness, &prep.limits);
        if target.plugin().is_none() && !own.iter().any(|r| r.code == codes::PLUGIN_INFO_MISSING) {
            own.push(Reason::new(codes::PLUGIN_INFO_MISSING));
        }
        push_unique(&mut blocking, own);
    }
    let up_to_date = to.is_some() && prep.up_to_date(&plans);
    let needs_consent = to.is_some() && prep.needs_consent(&plans);

    // This machine's side, under the plugins lock: the takeovers and the
    // links' preflights as the update would make them.
    let mut checked = None;
    if let Some(to) = &to {
        match local.plugins.lock().await {
            Ok(guard) => {
                let guard = Arc::new(guard);
                let change = update_change(&prep, &from, to, plans.clone(), BTreeMap::new());
                match locked_check(local, &guard, &change).await? {
                    Ok(found) => checked = Some(found),
                    Err(reason) => blocking.push(reason),
                }
            }
            Err(error) => blocking.push(Reason::new(error.code()).detail(error.to_string())),
        }
    }
    let codex_hooks = target
        .and_then(Rev::plugin)
        .and_then(|plugin| {
            plugin
                .hosts
                .iter()
                .find(|host| host.host == HostId::Codex.as_str())
        })
        .is_some_and(|host| host.hooks > 0);
    let mut hosts_out = Vec::new();
    for plan in &plans {
        let Some(before) = plan.before.clone() else {
            continue;
        };
        let after = plan.after.clone().unwrap_or_else(|| before.clone());
        let mut row = UpdateHost {
            agent: plan.agent,
            host_id: HostId::for_agent(plan.agent).map(|host| host.as_str().to_string()),
            mode: before.mode,
            state: before.state.clone(),
            to_mode: after.mode,
            to_state: after.state.clone(),
            action: plan.action,
            why_not: plan.why_not.clone(),
            detect: prep.detects.get(&plan.agent).map(plan_detect),
            experts_to_take_over: Vec::new(),
            experts_ack: None,
            experts_to_give_back: plan.give_back.clone(),
            codex_hooks_need_trust: after.mode == HostMode::Native
                && HostId::for_agent(plan.agent) == Some(HostId::Codex)
                && codex_hooks,
            skills: None,
        };
        if let Some(found) = &checked {
            row.experts_to_take_over = found
                .answer
                .experts_to_take_over
                .get(&plan.agent)
                .cloned()
                .unwrap_or_default();
            row.experts_ack = found.answer.experts_acks.get(&plan.agent).cloned();
            row.skills = found.answer.skills.get(&plan.agent).cloned();
        }
        hosts_out.push(row);
    }
    if let Some(found) = &checked {
        push_unique(&mut blocking, found.refusals.clone());
    }
    let latest_blocking = prep
        .latest
        .as_ref()
        .map(|latest| revision_blocking(latest, harness, &prep.limits))
        .unwrap_or_default();
    Ok(HarnessPluginUpdatePlan {
        installed: installed_view(prep.name.as_str(), &prep.entry),
        item: target.map(plan_item),
        item_status: prep.item_status,
        latest: prep
            .latest
            .as_ref()
            .map(|latest| plan_revision(latest, latest_blocking, false)),
        full: prep
            .full
            .as_ref()
            .map(|full| plan_revision(full, prep.whole.clone(), true)),
        not_full: prep.not_full,
        target: target.map(Rev::revision),
        revision_from: prep.entry.revision,
        version_from: prep.entry.version.clone(),
        version_to: target.and_then(|target| target.info.version.version.clone()),
        changed_members: to
            .as_ref()
            .map(|to| changed_members(&from.components, &to.components)),
        up_to_date,
        needs_consent,
        consent_exec: prep.target_exec(),
        autorun: target
            .and_then(Rev::plugin)
            .map(|plugin| plugin.autorun.clone())
            .unwrap_or_default(),
        snapshot: target.and_then(Rev::state).cloned(),
        state_sha256,
        hosts: hosts_out,
        blocking,
        warnings: Vec::new(),
        limits: prep.limits.clone(),
    })
}

/// The update as one operation.
fn update_change(
    prep: &UpdatePrep,
    from: &RevFiles,
    to: &RevFiles,
    plans: Vec<AgentPlan>,
    acks: BTreeMap<AgentType, BTreeMap<String, String>>,
) -> Change {
    let mut after = entry_after(&prep.entry, &plans);
    if let Some(target) = prep.target() {
        let info = &target.info;
        after.revision = info.version.revision;
        after.version = info.version.version.clone();
        after.archive_sha256 = info.archive.as_ref().map(|archive| archive.sha256.clone());
        after.source = if info.archive.is_none() {
            info.source.as_ref().map(record::RecordSource::from)
        } else {
            None
        };
        after.files = info.files.iter().map(record::RecordFile::from).collect();
        if let Some(plugin) = target.plugin() {
            after.exec_sha256 = plugin.exec_sha256.clone();
            after.autorun = plugin
                .autorun
                .iter()
                .map(record::AutorunEntry::from)
                .collect();
            after.components = plugin
                .components
                .iter()
                .map(RecordComponent::from)
                .collect();
        }
        after.state_sha256 = to.origin.state_sha256.clone();
    }
    Change {
        action: Action::Update,
        name: prep.name.clone(),
        before: prep.entry.clone(),
        after,
        from: from.clone(),
        to: to.clone(),
        plans,
        detects: prep.detects.clone(),
        acks,
        experts_acks: BTreeMap::new(),
        best_effort: false,
        done: PluginInstallOutcome::Updated,
    }
}

/// Move every agent to the plan's target, with what the user confirmed.
pub(crate) async fn update(
    local: &PluginsLocal,
    harness: &Harness,
    emitter: &EventEmitter,
    request: HarnessPluginUpdateRequest,
) -> Result<HarnessPluginInstallResult, AppCommandError> {
    harness.ensure_enabled()?;
    let (name, entry) = match installed_entry(local, &request.item_id).await? {
        Ok(found) => found,
        Err(reason) => return Ok(refused(reason)),
    };
    let prep = prepare_update(local, harness, name, entry).await?;
    let blocking = prep.blocking();
    if !blocking.is_empty() {
        return Ok(HarnessPluginInstallResult::refused(blocking));
    }
    let Some(target) = prep.target() else {
        return Ok(refused(Reason::new(codes::NO_FULL)));
    };
    // The target is chosen as the install chose it: `full` while any
    // agent has it as a plugin.
    let native = prep.any_native;
    if target.revision() != request.revision {
        return Ok(HarnessPluginInstallResult {
            issues: vec![Reason::new(codes::REVISION_NOT_TARGET)
                .param("revision", request.revision.to_string())
                .param("expected", target.revision().to_string())
                .param("mode", if native { "native" } else { "skills" })],
            ..HarnessPluginInstallResult::new(PluginInstallOutcome::Aborted)
        });
    }
    let Some(plugin) = target.plugin().cloned() else {
        return Ok(refused(Reason::new(codes::PLUGIN_INFO_MISSING)));
    };
    let own = revision_blocking(target, harness, &prep.limits);
    if !own.is_empty() {
        return Ok(HarnessPluginInstallResult {
            issues: own,
            ..HarnessPluginInstallResult::new(PluginInstallOutcome::Aborted)
        });
    }
    let Some(to) = prep.to(&request.state_sha256) else {
        return Ok(refused(Reason::new(codes::PLUGIN_INFO_MISSING)));
    };
    let from = prep.from();
    let plans = prep.plans(&local.skills.ctx, &to);
    if prep.up_to_date(&plans) {
        return Ok(refused(
            Reason::new(codes::UP_TO_DATE).param("revision", target.revision().to_string()),
        ));
    }

    // What runs on its own: agreed to again when the plan says so; else the
    // agreement on record stands (it is for this very exec_sha256).
    let needs_consent = prep.needs_consent(&plans);
    let target_exec = prep.target_exec();
    if needs_consent {
        let stop = match &request.consent_exec {
            None => Some(Reason::new(codes::CONSENT_REQUIRED)),
            Some(given) if Some(given) != target_exec.as_ref() => Some(
                Reason::new(codes::CONSENT_STALE)
                    .param("expected", target_exec.clone().unwrap_or_default()),
            ),
            Some(_) => None,
        };
        if let Some(stop) = stop {
            let mut answer = refused(stop);
            answer.consent_required = true;
            answer.consent_exec = target_exec;
            return Ok(answer);
        }
    }
    // What the snapshot check takes as agreed: the request's, the record's,
    // or — no agent runs it once updated — the target's own.
    let consent_exec = if needs_consent {
        request.consent_exec.clone()
    } else if prep.native_after {
        prep.entry
            .consent
            .as_ref()
            .map(|consent| consent.exec.clone())
    } else {
        target_exec.clone()
    };
    let as_install = HarnessPluginInstallRequest {
        item_ref: prep.entry.item_ref.clone(),
        revision: request.revision,
        install_name: prep.name.to_string(),
        state_sha256: request.state_sha256.clone(),
        consent_exec,
        accept_yanked: request.accept_yanked,
        ..Default::default()
    };
    let fresh = harness_skills::resolve_one(harness, &prep.entry.item_id, request.revision).await?;
    if let Some(stop) = fresh_refusal(&fresh, &as_install, native, &plugin) {
        return Ok(stop);
    }

    // The package, unless the revision is in place already.
    // (The folder of the revision there is too, when it is not what its
    // listing says: put back before anything loads it.)
    let moving = to.revision != prep.entry.revision;
    let dir = local.plugins.revision_dir(&prep.name, to.revision);
    let listing = to.listing.clone();
    let there = off_thread(move || store::verify_revision(&dir, &listing).is_ok()).await?;
    let stage = if moving || !there {
        let files = if there {
            Vec::new()
        } else {
            match package::fetch(
                harness,
                &local.skills.raw_origin,
                &target.info,
                &prep.limits,
            )
            .await?
            {
                Ok(files) => files,
                Err(issues) => {
                    return Ok(HarnessPluginInstallResult {
                        issues,
                        name: Some(prep.name.to_string()),
                        ..HarnessPluginInstallResult::new(PluginInstallOutcome::InvalidPackage)
                    })
                }
            }
        };
        Some(Stage {
            files,
            replace: !moving,
        })
    } else {
        None
    };

    let mut change = update_change(&prep, &from, &to, plans, request.acks.clone());
    change.experts_acks = request.experts_acks.clone();
    if prep.native_after && plugin.runs_on_its_own() {
        change.after.consent = match (&prep.entry.consent, needs_consent) {
            (Some(consent), false) => Some(consent.clone()),
            _ => Some(Consent {
                exec: request.consent_exec.clone().unwrap_or_default(),
                at: now(),
                extra: Default::default(),
            }),
        };
    }
    let recheck = Recheck {
        harness,
        request: as_install,
        native,
        plugin,
    };
    checked_carry_out(
        local,
        emitter,
        change,
        false,
        |_| {},
        || None,
        stage,
        Some(recheck),
    )
    .await
}

// ─── A change of mode ───────────────────────────────────────────────────

/// What may be installed whole of the record's revision now, for one
/// agent: the install's gates passed.
struct NativeGate {
    plugin: PluginInfo,
    fresh: Resolved,
    detect: Detect,
    exec: Option<String>,
}

async fn native_gate(
    local: &PluginsLocal,
    harness: &Harness,
    entry: &PluginEntry,
    name: &InstallName,
    agent: AgentType,
) -> Result<Result<NativeGate, Vec<Reason>>, AppCommandError> {
    harness.ensure_enabled()?;
    let Some((host, adapter)) = local.adapter(agent) else {
        return Ok(Err(vec![
            local.no_adapter(agent)
        ]));
    };
    let fresh = harness_skills::resolve_one(harness, &entry.item_id, entry.revision).await?;
    let item_ref = item_ref_of(entry, Some(&fresh))?;
    let info = harness.install_info(&item_ref, entry.revision).await?;
    let Some(plugin) = info.plugin.clone() else {
        return Ok(Err(vec![Reason::new(codes::PLUGIN_INFO_MISSING)]));
    };
    let config = harness.config().await?;
    let switches = AdapterSwitches::from_config(&config);
    let mut issues = Vec::new();
    if !plugin.mcp_unpinned.is_empty() {
        issues.push(
            Reason::new(codes::MCP_UNPINNED).param("servers", plugin.mcp_unpinned.join(", ")),
        );
    }
    let detect = adapter.detect(&local.env(agent), &switches).await;
    let why = if !detect.supported {
        Some(
            detect
                .why_not
                .clone()
                .unwrap_or_else(|| Reason::new(hosts::codes::HOST_NOT_FOUND)),
        )
    } else if !host.listed_in(&plugin) {
        Some(Reason::new(hosts::codes::HOST_NOT_LISTED))
    } else if host == HostId::OpenCode {
        let dir = local.plugins.revision_dir(name, entry.revision);
        let task = plugin.clone();
        off_thread(move || OpenCodeAdapter::installable(&task, &dir).err()).await?
    } else {
        None
    };
    if let Some(why) = why {
        let mut reason = Reason::new(codes::NATIVE_UNAVAILABLE)
            .param("agent", wire(agent))
            .param("why", why.code.clone());
        if let Some(detail) = why.detail {
            reason = reason.detail(detail);
        }
        issues.push(reason);
    }
    // The revision is the item's `full` one, approved, still there.
    let standing = fresh
        .installed
        .as_ref()
        .and_then(|state| state.plugin.clone())
        .unwrap_or_default();
    let blocked =
        snapshot::item_blocking_as(&fresh, entry.revision, Kind::Plugin, codes::NOT_A_PLUGIN);
    if blocked.is_empty() {
        issues.extend(harness_skills::package_reasons(fresh.installed.as_ref()).0);
        if standing.full.as_ref().map(|full| full.revision) != Some(entry.revision) {
            issues.push(
                Reason::new(codes::REVISION_NOT_TARGET)
                    .param("revision", entry.revision.to_string())
                    .param(
                        "expected",
                        standing
                            .full
                            .as_ref()
                            .map(|full| full.revision.to_string())
                            .unwrap_or_default(),
                    )
                    .param("mode", "native"),
            );
        }
        if !standing.approved {
            issues.push(
                Reason::new(codes::NOT_APPROVED).param("revision", entry.revision.to_string()),
            );
        }
        if fresh
            .advisories
            .iter()
            .any(|advisory| advisory.disables(entry.revision))
        {
            issues.push(Reason::new(codes::ADVISORY_DISABLE));
        }
        if fresh
            .installed
            .as_ref()
            .is_some_and(|state| state.status == VersionStatus::Yanked)
        {
            issues.push(Reason::new(shared::YANKED));
        }
    }
    issues.extend(blocked);
    if !issues.is_empty() {
        return Ok(Err(issues));
    }
    let exec = standing
        .exec_sha256
        .clone()
        .or_else(|| Some(plugin.exec_sha256.clone()));
    Ok(Ok(NativeGate {
        plugin,
        fresh,
        detect,
        exec,
    }))
}

/// One agent to have the plugin another way (or not at all), at the
/// record's revision. `preflight`: what it would take (the links'
/// preflight and its `acks`, the Experts takeover and its `ack`, what to
/// agree to, the snapshot to confirm).
pub(crate) async fn set_host_mode(
    local: &PluginsLocal,
    harness: &Harness,
    emitter: &EventEmitter,
    request: HarnessPluginSetHostRequest,
) -> Result<HarnessPluginInstallResult, AppCommandError> {
    let agent = request.agent;
    let (name, entry) = match installed_entry(local, &request.item_id).await? {
        Ok(found) => found,
        Err(reason) => return Ok(refused(reason)),
    };
    let current = entry.hosts.get(&wire(agent)).cloned();
    if current
        .as_ref()
        .is_some_and(|host| host.state == HostState::NeedsRepair)
    {
        return Ok(refused(needs_repair_reason(&[agent])));
    }
    let new_mode = request.mode.host_mode();
    if current.as_ref().map(|host| host.mode) == new_mode {
        return Ok(refused(
            Reason::new(codes::UNCHANGED).param("agent", wire(agent)),
        ));
    }
    if new_mode.is_none() && entry.hosts.len() == 1 {
        return Ok(refused(
            Reason::new(codes::LAST_HOST).param("agent", wire(agent)),
        ));
    }
    match new_mode {
        Some(HostMode::Skills) if !local.skills_ok(agent) => {
            return Ok(refused(
                Reason::new(skill_codes::AGENT_UNSUPPORTED).param("agent", wire(agent)),
            ))
        }
        Some(HostMode::Native) if local.adapter(agent).is_none() => {
            return Ok(refused(
                local.no_adapter(agent),
            ))
        }
        _ => {}
    }

    // As a plugin: the install's gates, on the fresh snapshot.
    let mut gate = None;
    if new_mode == Some(HostMode::Native) {
        match native_gate(local, harness, &entry, &name, agent).await? {
            Ok(found) => gate = Some(found),
            Err(issues) => return Ok(HarnessPluginInstallResult::refused(issues)),
        }
    }
    let rev = RevFiles::recorded(&entry, gate.as_ref().map(|gate| gate.plugin.clone()));
    let rev = if new_mode == Some(HostMode::Skills) && rev.components.is_empty() {
        rev_with_info(harness, &entry).await?
    } else {
        rev
    };
    let names = rev.skill_names();

    let mut plan = AgentPlan::new(agent, current.clone());
    match (current.clone(), new_mode) {
        (None, Some(mode)) => {
            plan.acts.push(match mode {
                HostMode::Native => Act::NativeInstall(At::To),
                HostMode::Skills => Act::SkillsPut {
                    at: At::To,
                    undo_to: None,
                },
            });
            plan.take_over = true;
            let mut host = HostEntry::new(mode);
            if mode == HostMode::Skills {
                host.skills = names.clone();
            }
            plan.after = Some(host);
        }
        (Some(mut host), Some(HostMode::Skills)) => {
            // From a plugin to its skills.
            plan.acts = vec![
                Act::NativeUninstall {
                    at: At::From,
                    was_on: host.state == HostState::Active,
                },
                Act::SkillsPut {
                    at: At::To,
                    undo_to: None,
                },
            ];
            plan.take_over = true;
            host.mode = HostMode::Skills;
            host.state = HostState::Active;
            host.host_name = None;
            host.skills = names.clone();
            plan.after = Some(host);
        }
        (Some(mut host), Some(HostMode::Native)) => {
            // From its skills to a plugin.
            if host.state != HostState::DisabledByUser {
                plan.acts.push(Act::SkillsRemove(At::From));
            }
            plan.acts.push(Act::NativeInstall(At::To));
            plan.take_over = true;
            host.mode = HostMode::Native;
            host.state = HostState::Active;
            host.skills = Vec::new();
            plan.after = Some(host);
        }
        (Some(host), None) => {
            match host.mode {
                HostMode::Native => plan.acts.push(Act::NativeUninstall {
                    at: At::From,
                    was_on: host.state == HostState::Active,
                }),
                // Skills switched off have no links to take out.
                HostMode::Skills if host.state == HostState::DisabledByUser => {}
                HostMode::Skills => plan.acts.push(Act::SkillsRemove(At::From)),
            }
            plan.give_back = host.experts.clone();
            plan.after = None;
        }
        (None, None) => {
            return Ok(refused(
                Reason::new(codes::NOT_ON_AGENT).param("agent", wire(agent)),
            ))
        }
    }
    let plans = vec![plan];
    let mut after = entry_after(&entry, &plans);
    // What runs on its own, as a plugin: agreed to for this exec_sha256.
    let consent_required = gate.as_ref().is_some_and(|gate| {
        gate.plugin.runs_on_its_own()
            && entry.consent.as_ref().map(|consent| &consent.exec) != gate.exec.as_ref()
    });
    let consent_exec = gate.as_ref().and_then(|gate| gate.exec.clone());
    if consent_required {
        after.consent = Some(Consent {
            exec: request.consent_exec.clone().unwrap_or_default(),
            at: now(),
            extra: Default::default(),
        });
    }
    let mut detects = BTreeMap::new();
    if let Some(gate) = &gate {
        detects.insert(agent, gate.detect.clone());
    }
    let change = Change {
        action: Action::Change,
        name,
        before: entry.clone(),
        after,
        from: rev.clone(),
        to: rev,
        plans,
        detects,
        acks: BTreeMap::from([(agent, request.acks.clone())]),
        experts_acks: request
            .experts_ack
            .clone()
            .map(|ack| BTreeMap::from([(agent, ack)]))
            .unwrap_or_default(),
        best_effort: false,
        done: PluginInstallOutcome::Changed,
    };
    let fresh_state = gate.as_ref().and_then(|gate| gate.fresh.installed.clone());
    let fresh_sha = fresh_state
        .as_ref()
        .and_then(|state| state.state_sha256.clone());
    let (state_for_answer, sha_for_answer) = (fresh_state.clone(), fresh_sha.clone());
    let recheck = gate.map(|gate| Recheck {
        harness,
        request: HarnessPluginInstallRequest {
            item_ref: entry.item_ref.clone(),
            revision: entry.revision,
            install_name: change.name.to_string(),
            state_sha256: request.state_sha256.clone().unwrap_or_default(),
            consent_exec: if consent_required {
                request.consent_exec.clone()
            } else {
                gate.exec.clone()
            },
            ..Default::default()
        },
        native: true,
        plugin: gate.plugin,
    });
    let native = new_mode == Some(HostMode::Native);
    let given_state = request.state_sha256.clone();
    let given_consent = request.consent_exec.clone();
    checked_carry_out(
        local,
        emitter,
        change,
        request.preflight,
        |answer| {
            answer.consent_required = consent_required;
            answer.consent_exec = consent_exec.clone();
            answer.snapshot = state_for_answer;
            answer.state_sha256 = sha_for_answer;
        },
        || {
            if !native {
                return None;
            }
            if given_state.is_none() || given_state != fresh_sha {
                if let Some(state) = &fresh_state {
                    snapshot::remember(state);
                }
                let confirmed = given_state.as_deref().and_then(snapshot::recall);
                return Some(HarnessPluginInstallResult {
                    changes: fresh_state
                        .as_ref()
                        .map(|state| snapshot::changes(confirmed.as_ref(), state))
                        .unwrap_or_default(),
                    snapshot: fresh_state.clone(),
                    state_sha256: fresh_sha.clone(),
                    ..HarnessPluginInstallResult::new(PluginInstallOutcome::StateChanged)
                });
            }
            if consent_required {
                let stop = match &given_consent {
                    None => Some(Reason::new(codes::CONSENT_REQUIRED)),
                    Some(given) if Some(given) != consent_exec.as_ref() => Some(
                        Reason::new(codes::CONSENT_STALE)
                            .param("expected", consent_exec.clone().unwrap_or_default()),
                    ),
                    Some(_) => None,
                };
                if let Some(stop) = stop {
                    let mut answer = refused(stop);
                    answer.consent_required = true;
                    answer.consent_exec = consent_exec.clone();
                    return Some(answer);
                }
            }
            None
        },
        None,
        recheck,
    )
    .await
}

/// The record's revision with its install info (an entry written before
/// the members were kept in it).
async fn rev_with_info(
    harness: &Harness,
    entry: &PluginEntry,
) -> Result<RevFiles, AppCommandError> {
    let item_ref = ItemRef::parse(&entry.item_ref)?;
    let info = harness.install_info(&item_ref, entry.revision).await?;
    Ok(RevFiles::recorded(entry, info.plugin))
}

// ─── Off and on ─────────────────────────────────────────────────────────

/// One agent's plugin switched off by the user, or on again. Turning on
/// what runs on its own needs SRN to vouch for the revision now; one Codeg
/// turned off is turned on only by an update.
pub(crate) async fn set_enabled(
    local: &PluginsLocal,
    harness: &Harness,
    emitter: &EventEmitter,
    request: HarnessPluginSetEnabledRequest,
) -> Result<HarnessPluginInstallResult, AppCommandError> {
    let agent = request.agent;
    let (name, entry) = match installed_entry(local, &request.item_id).await? {
        Ok(found) => found,
        Err(reason) => return Ok(refused(reason)),
    };
    let Some(current) = entry.hosts.get(&wire(agent)).cloned() else {
        return Ok(refused(
            Reason::new(codes::NOT_ON_AGENT).param("agent", wire(agent)),
        ));
    };
    match &current.state {
        HostState::NeedsRepair => return Ok(refused(needs_repair_reason(&[agent]))),
        HostState::Suspended { reason, .. } => {
            return Ok(refused(
                Reason::new(codes::SUSPENDED)
                    .param("agent", wire(agent))
                    .param("reason", reason.clone()),
            ))
        }
        HostState::Active if request.enabled => {
            return Ok(refused(
                Reason::new(codes::UNCHANGED).param("agent", wire(agent)),
            ))
        }
        HostState::DisabledByUser if !request.enabled => {
            return Ok(refused(
                Reason::new(codes::UNCHANGED).param("agent", wire(agent)),
            ))
        }
        _ => {}
    }
    if current.mode == HostMode::Native && local.adapter(agent).is_none() {
        return Ok(refused(
            local.no_adapter(agent),
        ));
    }
    // On again, as a plugin, with something that runs on its own: only
    // while SRN vouches for it, and with the user's agreement to it.
    if request.enabled && current.mode == HostMode::Native && !entry.autorun.is_empty() {
        let fresh = harness_skills::resolve_one(harness, &entry.item_id, entry.revision).await?;
        if let Some(why) = not_vouched(&fresh, entry.revision) {
            return Ok(refused(why));
        }
        if entry.consent.as_ref().map(|consent| &consent.exec) != Some(&entry.exec_sha256) {
            let mut answer = refused(Reason::new(codes::CONSENT_REQUIRED));
            answer.consent_required = true;
            answer.consent_exec = Some(entry.exec_sha256.clone());
            return Ok(answer);
        }
    }
    let mut rev = RevFiles::recorded(&entry, None);
    if request.enabled {
        // On again as a plugin: pointed at the record's revision first, by
        // the names its manifests give (from the install info, when it can
        // be read).
        if current.mode == HostMode::Native {
            if let Ok(found) = rev_with_info(harness, &entry).await {
                rev = found;
            }
        } else if rev.components.is_empty() {
            rev = rev_with_info(harness, &entry).await?;
        }
    }
    let mut plan = AgentPlan::new(agent, Some(current.clone()));
    let mut host = current.clone();
    match (current.mode, request.enabled) {
        (HostMode::Native, true) => {
            plan.acts.push(Act::NativeUpdate {
                from: At::To,
                to: At::To,
                undo_off: true,
            });
            plan.acts.push(Act::NativeEnable(At::To));
        }
        (HostMode::Native, false) => plan.acts.push(Act::NativeDisable(At::To)),
        (HostMode::Skills, true) => plan.acts.push(Act::SkillsPut {
            at: At::To,
            undo_to: None,
        }),
        (HostMode::Skills, false) => plan.acts.push(Act::SkillsRemove(At::To)),
    }
    plan.take_over = request.enabled;
    host.state = if request.enabled {
        HostState::Active
    } else {
        HostState::DisabledByUser
    };
    plan.after = Some(host);
    let plans = vec![plan];
    let after = entry_after(&entry, &plans);
    let change = Change {
        action: Action::Change,
        name,
        before: entry,
        after,
        from: rev.clone(),
        to: rev,
        plans,
        detects: BTreeMap::new(),
        acks: BTreeMap::from([(agent, request.acks.clone())]),
        experts_acks: request
            .experts_ack
            .clone()
            .map(|ack| BTreeMap::from([(agent, ack)]))
            .unwrap_or_default(),
        best_effort: false,
        done: PluginInstallOutcome::Changed,
    };
    checked_carry_out(
        local,
        emitter,
        change,
        request.preflight,
        |_| {},
        || None,
        None,
        None,
    )
    .await
}

// ─── Repair ─────────────────────────────────────────────────────────────

/// The agents an interrupted operation left brought back to the record's
/// revision and mode, and to the state each had (`RepairNote::was`): each
/// host step re-run (whatever the other mode a cut-short change may have
/// left taken out first), then checked. A repair never runs what was not
/// running: an agent that was off is switched off and pointed at the
/// record's revision in its host, never put in; what runs on its own runs
/// again only while SRN vouches for it now — else it is switched off so and
/// left `Suspended` (only an update turns it on). An agent that cannot be
/// repaired stays marked; the others are done.
pub(crate) async fn repair(
    local: &PluginsLocal,
    harness: &Harness,
    emitter: &EventEmitter,
    request: HarnessPluginRepairRequest,
) -> Result<HarnessPluginInstallResult, AppCommandError> {
    let (name, entry) = match installed_entry(local, &request.item_id).await? {
        Ok(found) => found,
        Err(reason) => return Ok(refused(reason)),
    };
    let mut targets: Vec<(AgentType, HostEntry)> = Vec::new();
    for (agent_wire, host) in &entry.hosts {
        let Some(agent) = AgentType::from_wire(agent_wire) else {
            continue;
        };
        if request.agent.is_some_and(|asked| asked != agent) {
            continue;
        }
        if host.state == HostState::NeedsRepair {
            targets.push((agent, host.clone()));
        }
    }
    if targets.is_empty() {
        let agent = request.agent.map(wire).unwrap_or_default();
        return Ok(refused(
            Reason::new(codes::NO_REPAIR_NEEDED).param("agent", agent),
        ));
    }
    // An agent that cannot be seen to now stays marked; the others go on.
    // What it may have as a plugin (its mode, or the other one of a cut-short
    // change) is only seen to through its host.
    let mut unreachable: Vec<(AgentType, Reason)> = Vec::new();
    targets.retain(|(agent, host)| {
        let native_too = host.mode == HostMode::Native
            || host
                .repair
                .as_ref()
                .is_some_and(|note| note.other_modes.contains(&HostMode::Native));
        let why = if native_too && local.adapter(*agent).is_none() {
            Some(local.no_adapter(*agent))
        } else if host.mode == HostMode::Skills && !local.skills_ok(*agent) {
            Some(Reason::new(skill_codes::AGENT_UNSUPPORTED).param("agent", wire(*agent)))
        } else {
            None
        };
        match why {
            Some(why) => {
                unreachable.push((*agent, why));
                false
            }
            None => true,
        }
    });
    if targets.is_empty() {
        return Ok(HarnessPluginInstallResult::refused(
            unreachable.into_iter().map(|(_, why)| why).collect(),
        ));
    }
    // An uninstall that stopped on an agent is finished: nothing of the
    // revision is needed for that (nor asked of SRN).
    let leaving = |host: &HostEntry| host.repair.as_ref().is_some_and(|note| note.uninstalling);
    let staying: Vec<&(AgentType, HostEntry)> =
        targets.iter().filter(|(_, host)| !leaving(host)).collect();
    let any_skills = staying
        .iter()
        .any(|(_, host)| host.mode == HostMode::Skills);
    let any_native = staying
        .iter()
        .any(|(_, host)| host.mode == HostMode::Native);
    let mut rev = RevFiles::recorded(&entry, None);
    // As a plugin: the hosts' manifests (the name each host knows it by)
    // come with the install info. Without it nothing is put into a host
    // (what is there can still be switched off).
    let mut catalog_down = false;
    if any_native || (any_skills && rev.components.is_empty()) {
        match rev_with_info(harness, &entry).await {
            Ok(found) => rev = found,
            Err(error) if any_skills && rev.components.is_empty() => return Err(error),
            Err(_) => catalog_down = true,
        }
    }

    // The revision's folder: put back when it is not what its listing says.
    let dir = local.plugins.revision_dir(&name, entry.revision);
    let listing = rev.listing.clone();
    let intact = staying.is_empty()
        || off_thread(move || store::verify_revision(&dir, &listing).is_ok()).await?;
    let stage = if intact {
        None
    } else {
        match repair_files(local, harness, &entry).await {
            Ok(Ok(files)) => Some(Stage {
                files,
                replace: true,
            }),
            Ok(Err(issues)) => {
                return Ok(HarnessPluginInstallResult {
                    issues,
                    name: Some(name.to_string()),
                    ..HarnessPluginInstallResult::new(PluginInstallOutcome::InvalidPackage)
                })
            }
            // The catalog cannot be asked: nothing goes into a host, what is
            // there can still be switched off.
            Err(_) => {
                catalog_down = true;
                None
            }
        }
    };

    // Without the revision's files: native agents are only switched off,
    // skills agents wait (both stay marked).
    let files_missing = !intact && stage.is_none();

    // What runs on its own runs again only while SRN vouches for it, and
    // for what the user agreed to.
    let was_of = |host: &HostEntry| {
        host.repair
            .as_ref()
            .and_then(|note| note.was.clone())
            .filter(|was| *was != HostState::NeedsRepair)
            .unwrap_or(HostState::Active)
    };
    let mut off_because: Option<Reason> = None;
    let runs_again = staying.iter().any(|(_, host)| {
        host.mode == HostMode::Native
            && matches!(was_of(host), HostState::Active | HostState::DisabledByUser)
    });
    if catalog_down && runs_again {
        off_because = Some(Reason::new(codes::UNVERIFIED));
    } else if !entry.autorun.is_empty() && runs_again {
        off_because =
            match harness_skills::resolve_one(harness, &entry.item_id, entry.revision).await {
                Ok(fresh) => not_vouched(&fresh, entry.revision),
                Err(_) => Some(Reason::new(codes::UNVERIFIED)),
            };
        if off_because.is_none()
            && entry.consent.as_ref().map(|consent| &consent.exec) != Some(&entry.exec_sha256)
        {
            off_because = Some(Reason::new(codes::CONSENT_REQUIRED));
        }
    }
    // After a backup was restored: an agent that ran it as a plugin goes on
    // running it only when its host has it as the record says (switched on,
    // at the record's revision); else it is switched off and repointed,
    // never put in or on.
    let restored_running: Vec<AgentType> = staying
        .iter()
        .filter(|(_, host)| {
            host.mode == HostMode::Native
                && host.repair.as_ref().is_some_and(|note| note.restored)
                && was_of(host) == HostState::Active
        })
        .map(|(agent, _)| *agent)
        .collect();
    let mut matching: BTreeSet<AgentType> = BTreeSet::new();
    if !restored_running.is_empty() && !files_missing {
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
        for agent in &restored_running {
            let Some((host_id, adapter)) = local.adapter(*agent) else {
                continue;
            };
            // Codex runs its own copy, which `verify` cannot tell from
            // another revision's of the same version: only switched off.
            if host_id == HostId::Codex {
                continue;
            }
            let host_name = entry
                .hosts
                .get(&wire(*agent))
                .and_then(|host| host.host_name.clone());
            let env = local.env(*agent);
            let cx = HostCx {
                ctx: &local.plugins,
                env: &env,
                cli: None,
                lock: &guard,
            };
            let found = adapter
                .verify(&cx, &rev.host_plugin(&name, host_id, host_name.as_deref()))
                .await;
            if found.ok() && found.enabled == Some(true) {
                matching.insert(*agent);
            }
        }
    }
    let names = rev.skill_names();
    let mut plans = Vec::new();
    let mut waiting: Vec<AgentType> = Vec::new();
    for (agent, host) in &targets {
        let note = host.repair.clone().unwrap_or_default();
        // Another agent has the skills where this one reads them too (or
        // reads them where this one links): those links are not this one's
        // to take.
        let ctx = &local.skills.ctx;
        let crossed = entry.hosts.iter().any(|(other, host)| {
            let Some(other) = AgentType::from_wire(other) else {
                return false;
            };
            other != *agent
                && host.mode == HostMode::Skills
                && matches!(host.state, HostState::Active | HostState::NeedsRepair)
                && (audience(ctx, other).contains(agent) || audience(ctx, *agent).contains(&other))
        });
        if note.uninstalling {
            // The uninstall again, in its order (the host's own, or the
            // members' links out), then the Experts pack's links back; the
            // agent leaves the record. Never put back.
            let mut plan = AgentPlan::new(*agent, Some(host.clone()));
            let skills_too = host.mode == HostMode::Skills
                || (note.other_modes.contains(&HostMode::Skills) && !crossed);
            let native_too =
                host.mode == HostMode::Native || note.other_modes.contains(&HostMode::Native);
            if native_too && local.adapter(*agent).is_some() {
                plan.acts.push(Act::NativeUninstall {
                    at: At::To,
                    was_on: false,
                });
            }
            if skills_too {
                plan.acts.push(Act::SkillsRemove(At::To));
            }
            plan.give_back = host.experts.clone();
            plan.after = None;
            plans.push(plan);
            continue;
        }
        if files_missing && host.mode == HostMode::Skills {
            waiting.push(*agent);
            // What a change cut short may have left of the plugin in its
            // host goes all the same (no files needed); the skills wait.
            if note.other_modes.contains(&HostMode::Native) && local.adapter(*agent).is_some() {
                let mut plan = AgentPlan::new(*agent, Some(host.clone()));
                plan.acts.push(Act::NativeUninstall {
                    at: At::To,
                    was_on: false,
                });
                plans.push(plan);
            }
            continue;
        }
        let mut plan = AgentPlan::new(*agent, Some(host.clone()));
        let was = was_of(host);
        let mut after = host.clone();
        after.repair = None;
        match host.mode {
            HostMode::Native => {
                // What a change cut short may have left of its skills
                // (unless they are another agent's too, `crossed`).
                if note.other_modes.contains(&HostMode::Skills) && !crossed {
                    plan.acts.push(Act::SkillsRemove(At::To));
                }
                // Off (as it was — the user's own switch kept as theirs — or
                // SRN not vouching for it now): switched off and pointed at
                // the record's revision, never put in or on. One its host
                // does not have cannot be so: it stays marked (uninstall is
                // always there). Without the revision's files it is only
                // switched off, and stays marked.
                let off = match &was {
                    HostState::Suspended { .. } | HostState::DisabledByUser => Some(was.clone()),
                    _ => off_because
                        .as_ref()
                        .map(|why| HostState::suspended(why.code.clone())),
                };
                // After a restore: what its host has as the record says is
                // left running; anything else is only switched off (the
                // user may switch it on again).
                let off = match off {
                    None if note.restored && matching.contains(agent) => {
                        after.state = HostState::Active;
                        plan.after = Some(after);
                        plans.push(plan);
                        continue;
                    }
                    None if note.restored => Some(HostState::DisabledByUser),
                    off => off,
                };
                match off {
                    Some(_) if files_missing => {
                        plan.acts.push(Act::NativeDisable(At::To));
                        after = host.clone();
                    }
                    Some(state) => {
                        plan.acts.push(Act::NativeDisable(At::To));
                        plan.acts.push(Act::NativeRepoint {
                            from: At::To,
                            to: At::To,
                        });
                        after.state = state;
                    }
                    None if files_missing => {
                        plan.acts.push(Act::NativeDisable(At::To));
                        after = host.clone();
                    }
                    None => {
                        plan.acts.push(Act::NativeInstall(At::To));
                        after.state = HostState::Active;
                        plan.take_over = true;
                    }
                }
            }
            HostMode::Skills => {
                if note.other_modes.contains(&HostMode::Native) && local.adapter(*agent).is_some() {
                    plan.acts.push(Act::NativeUninstall {
                        at: At::To,
                        was_on: false,
                    });
                }
                after.skills = names.clone();
                match &was {
                    HostState::DisabledByUser | HostState::Suspended { .. } => {
                        plan.acts.push(Act::SkillsRemove(At::To));
                        after.state = was.clone();
                    }
                    _ => {
                        plan.acts.push(Act::SkillsPut {
                            at: At::To,
                            undo_to: None,
                        });
                        after.state = HostState::Active;
                        plan.take_over = true;
                    }
                }
            }
        }
        plan.after = Some(after);
        plans.push(plan);
    }
    let missing =
        Reason::new(hosts::codes::REVISION_MISSING).param("revision", entry.revision.to_string());
    if plans.is_empty() {
        return Ok(refused(missing));
    }
    sort_plans(&local.skills.ctx, &mut plans);
    let after = entry_after(&entry, &plans);
    let change = Change {
        action: Action::Change,
        name,
        before: entry,
        after,
        from: rev.clone(),
        to: rev,
        plans,
        detects: BTreeMap::new(),
        acks: request.acks.clone(),
        experts_acks: request.experts_acks.clone(),
        best_effort: true,
        done: PluginInstallOutcome::Repaired,
    };
    let mut done = checked_carry_out(
        local,
        emitter,
        change,
        request.preflight,
        |_| {},
        || None,
        stage,
        None,
    )
    .await?;
    if !unreachable.is_empty() {
        done.issues.extend(unreachable.iter().map(|(_, why)| why.clone()));
        done.needs_repair.extend(unreachable.iter().map(|(agent, _)| *agent));
        done.needs_repair.sort();
        done.needs_repair.dedup();
    }
    if files_missing {
        done.issues.push(missing);
        done.needs_repair.extend(waiting);
        done.needs_repair.extend(
            staying
                .iter()
                .filter(|(_, host)| host.mode == HostMode::Native)
                .map(|(agent, _)| *agent),
        );
        done.needs_repair.sort();
        done.needs_repair.dedup();
    }
    Ok(done)
}

/// What the check under the lock says of a change planned from `before`
/// (the code it refuses with), for the tests.
#[cfg(all(test, unix))]
pub(super) async fn stale_check(local: &PluginsLocal, before: PluginEntry) -> Option<String> {
    let (ctx, id) = (local.plugins.clone(), before.item_id.clone());
    let (name, _) = off_thread(move || find_entry(&ctx, &id, false))
        .await
        .ok()?
        .ok()?;
    let rev = RevFiles::recorded(&before, None);
    let change = Change {
        action: Action::Change,
        name,
        after: before.clone(),
        before,
        from: rev.clone(),
        to: rev,
        plans: Vec::new(),
        detects: BTreeMap::new(),
        acks: BTreeMap::new(),
        experts_acks: BTreeMap::new(),
        best_effort: false,
        done: PluginInstallOutcome::Changed,
    };
    let guard = Arc::new(local.plugins.lock().await.ok()?);
    match locked_check(local, &guard, &change).await.ok()? {
        Ok(_) => None,
        Err(reason) => Some(reason.code),
    }
}

/// The record's revision's files, fetched again (a repair whose folder is
/// not what its listing says). `Err`: the catalog cannot be asked.
async fn repair_files(
    local: &PluginsLocal,
    harness: &Harness,
    entry: &PluginEntry,
) -> Result<Result<Vec<PackageFile>, Vec<Reason>>, AppCommandError> {
    harness.ensure_enabled()?;
    let item_ref = ItemRef::parse(&entry.item_ref)?;
    let info = harness.install_info(&item_ref, entry.revision).await?;
    let config = harness.config().await?;
    let limits = package::limits_from_config(&config);
    Ok(package::fetch(harness, &local.skills.raw_origin, &info, &limits).await?)
}
