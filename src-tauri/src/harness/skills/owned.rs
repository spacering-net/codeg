//! A Harness plugin's member skills for one agent in "skills only" mode:
//! put into the plugin's own store (`crate::skills::owned`), each with its
//! Harness manifest entry (`plugin` = the install name; `item_id`, `ref`,
//! `revision` … the plugin's), and linked into the agent through the skills
//! engine — Windows' copies where no link can be made, the `ack` of effects
//! on other agents, and all — under the member's own name.
//!
//! The plugins module calls this under the plugins lock, taking the skills
//! lock for each call (plugins → skills; never with the MCP lock):
//!
//! - [`plan_owned`] / [`plan_remove_owned`]: what a call would do for an
//!   agent — the engine's preflight of its links (with the `ack`s), the
//!   Experts pack's links to take over first, and what holds a name.
//! - [`install_owned`]: one more agent. The store gets the set (it must hold
//!   exactly this set already when another agent has it), then the agent's
//!   links.
//! - [`replace_owned`]: an update for one agent. The store's set becomes
//!   `members` (added, changed, removed members), the agent's links follow;
//!   a member dropped from the set stays in the store while another agent
//!   still links it, and goes with that agent's own call.
//! - [`remove_owned`]: the agent's links out; every member no agent links
//!   any more out of the store; the store itself once empty.
//!
//! Each call checks everything before it writes; a refusal writes nothing.
//! Each member's store change is journaled like a Harness skill install
//! (`journal::Tx` in the plugin's store, recovered at startup), and the
//! links are one engine request (all or nothing). Every call is idempotent
//! and its [`OwnedReport`] says exactly what it changed — a failure partway
//! leaves the members already put in place, and says which — so the
//! plugin's journal can record a host step and undo it with the opposite
//! call (`remove_owned`, or `replace_owned` with the previous revision's
//! members). Nothing here announces: the caller does, from `touched` and
//! `store_changed`. Assistants are not installed in this mode (D2).

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::harness::mcp::model::Reason;
use crate::harness::types::{ComponentKind, FileEntry, PluginComponent, Source};
use crate::models::agent::AgentType;
use crate::skills::apply::{apply_after, preflight_pending, preflight_without, Plan, Step};
use crate::skills::lock::SkillsGuard;
use crate::skills::model::{
    codes as skill_codes, DirRole, OpStatus, SkillAction, SkillOp, SkillsApplyRequest,
    SkillsApplyResult, SkillsIssue,
};
use crate::skills::owned::{conflicts, ExpertLink, NameHeld, PluginOwner};
use crate::skills::world::{Entry, World};
use crate::skills::SkillsCtx;

use super::journal::{new_journal, Action, Tx};
use super::manifest::{self, Manifest, ManifestEntry};
use super::model::{codes, Rewrites};
use super::package::{safe_path, PackageFile};
use super::{file_changes, frontmatter, manifest_reason, names, refresh_copies, sha256_hex};

/// Codes only this mode reports (beside [`codes`]).
pub mod owned_codes {
    /// The Experts pack's links of some of the names are in the agent: take
    /// them over first (`skills::owned::unlink_experts`). Params: `names`.
    pub const EXPERTS_LINKED: &str = "experts_linked";
    /// Another agent has this plugin's skills of another set: an install
    /// for one more agent must be of the same revision. Update first.
    pub const OWNED_SET_DIFFERS: &str = "owned_set_differs";
    /// The plugin's store holds a member entry of another owner (a store
    /// reached under another spelling of the install name). Params: `name`,
    /// `plugin`.
    pub const OWNED_BY_OTHER: &str = "owned_by_other";
    /// Codeg's copies of a member could not be brought up to date (the old
    /// copies are back in place). Params: `name`.
    pub const COPIES_NOT_REFRESHED: &str = "copies_not_refreshed";
    /// Two members of one name (ignoring case). Params: `name`.
    pub const MEMBER_DUPLICATE: &str = "member_duplicate";
    /// A member's file is not what the revision's listing says. Params:
    /// `name`, `path`.
    pub const MEMBER_FILE_MISMATCH: &str = "member_file_mismatch";
}

/// One member skill: its name (the link's name in agents' directories and
/// its folder in the plugin's store) and its files (paths from its folder in
/// the revision) as the revision has them.
#[derive(Debug, Clone)]
pub(crate) struct OwnedMember {
    pub name: String,
    pub files: Vec<PackageFile>,
}

/// Where the members came from: the plugin's item and revision, written
/// into each member's manifest entry.
#[derive(Debug, Clone)]
pub(crate) struct OwnedOrigin {
    pub item_id: String,
    pub item_ref: String,
    pub revision: u64,
    pub version: Option<String>,
    pub archive_sha256: Option<String>,
    pub source: Option<Source>,
    pub state_sha256: String,
}

/// The skill members of a revision, read from its folder in the plugin
/// store (`<plugins root>/<name>/<revision>/`), each file checked against
/// the revision's listing. Assistants (and kinds this Codeg does not know)
/// are left out.
pub(crate) fn read_members(
    revision_dir: &Path,
    components: &[PluginComponent],
    listing: &[FileEntry],
) -> Result<Vec<OwnedMember>, Vec<Reason>> {
    let mut members = Vec::new();
    let mut issues = Vec::new();
    for component in components {
        if component.kind != ComponentKind::Skill {
            continue;
        }
        let name = component.name.clone();
        if !names::is_valid(&name) {
            issues.push(Reason::new(codes::NAME_INVALID).param("name", name));
            continue;
        }
        let folder = component.path.trim_end_matches('/').to_string();
        if !folder.is_empty() && !safe_path(&folder) {
            issues.push(Reason::new(codes::UNSAFE_PATH).param("path", folder));
            continue;
        }
        let prefix = if folder.is_empty() {
            String::new()
        } else {
            format!("{folder}/")
        };
        let mut files = Vec::new();
        for entry in listing.iter().filter(|e| e.path.starts_with(&prefix)) {
            let mismatch = || {
                Reason::new(owned_codes::MEMBER_FILE_MISMATCH)
                    .param("name", name.clone())
                    .param("path", entry.path.clone())
            };
            if !safe_path(&entry.path) {
                issues.push(mismatch());
                continue;
            }
            match fs::read(revision_dir.join(&entry.path)) {
                Ok(bytes) if sha256_hex(&bytes) == entry.sha256 => files.push(PackageFile {
                    path: entry.path[prefix.len()..].to_string(),
                    bytes,
                    executable: entry.executable,
                }),
                Ok(_) => issues.push(mismatch()),
                Err(error) => issues.push(mismatch().detail(error.to_string())),
            }
        }
        members.push(OwnedMember { name, files });
    }
    if issues.is_empty() {
        Ok(members)
    } else {
        Err(issues)
    }
}

// ─── What a call does ───────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OwnedOutcome {
    /// Everything done (or already so).
    Done,
    /// Cannot be done as asked; nothing written. See `issues`, `takeover`,
    /// `held`, `links`.
    Refused,
    /// The links change what other agents see: send back the `ack` of each
    /// op in `links` (by skill). Nothing written.
    AcknowledgementRequired,
    /// A write failed; see what was done (`added` …, `linked` …) and what
    /// was put back (`links`).
    WriteFailed,
}

/// What a call did — or, refused, why not.
#[derive(Debug, Clone, Serialize)]
pub struct OwnedReport {
    pub outcome: OwnedOutcome,
    pub plugin: String,
    pub agent: AgentType,
    pub issues: Vec<Reason>,
    /// Members put into the plugin's store.
    pub added: Vec<String>,
    /// Members whose content in the store was replaced.
    pub replaced: Vec<String>,
    /// Members whose manifest entry alone changed (a new revision with the
    /// same files).
    pub restamped: Vec<String>,
    /// Members taken out of the store (no agent links them any more).
    pub removed: Vec<String>,
    /// Members no longer in the set that stay in the store: another agent
    /// still links them.
    pub kept: Vec<String>,
    /// Members linked into the agent now.
    pub linked: Vec<String>,
    /// Members whose links (and copies) left the agent now.
    pub unlinked: Vec<String>,
    /// The engine's answer for the links (its preflight when refused or
    /// waiting for `ack`s).
    pub links: Option<SkillsApplyResult>,
    /// The Experts pack's links in the way (refused until taken over).
    pub takeover: Vec<ExpertLink>,
    /// What else holds a name ("name taken").
    pub held: Vec<NameHeld>,
    /// Folders of members the user had changed, kept among the backups.
    pub backups: Vec<String>,
    /// Codeg's copies of changed members brought up to date.
    pub copies_refreshed: Vec<String>,
    /// The agent's copies the user had changed, taken out with the plugin's
    /// skill (after a copy into `backups`).
    pub copies_taken: Vec<String>,
    /// What `SKILL.md` rewrites were made, by member.
    pub rewrites: BTreeMap<String, Rewrites>,
    /// Agents whose directories changed (for the event).
    pub touched: Vec<AgentType>,
    /// The plugin's store changed (for the event).
    pub store_changed: bool,
    /// What a failed rollback left where it is, for the next start.
    pub kept_paths: Vec<String>,
}

impl OwnedReport {
    fn new(owner: &PluginOwner, agent: AgentType) -> Self {
        Self {
            outcome: OwnedOutcome::Done,
            plugin: owner.name().to_string(),
            agent,
            issues: Vec::new(),
            added: Vec::new(),
            replaced: Vec::new(),
            restamped: Vec::new(),
            removed: Vec::new(),
            kept: Vec::new(),
            linked: Vec::new(),
            unlinked: Vec::new(),
            links: None,
            takeover: Vec::new(),
            held: Vec::new(),
            backups: Vec::new(),
            copies_refreshed: Vec::new(),
            copies_taken: Vec::new(),
            rewrites: BTreeMap::new(),
            touched: Vec::new(),
            store_changed: false,
            kept_paths: Vec::new(),
        }
    }

    fn refused(mut self, issues: Vec<Reason>) -> Self {
        self.outcome = OwnedOutcome::Refused;
        self.issues.extend(issues);
        self
    }

    pub fn ok(&self) -> bool {
        self.outcome == OwnedOutcome::Done
    }
}

/// What a call would do for an agent (no lock, nothing written).
#[derive(Debug, Clone, Serialize)]
pub struct OwnedPlan {
    pub plugin: String,
    pub agent: AgentType,
    /// The engine's preflight of the agent's links: per op (by `skill`) its
    /// effects and the `ack` to send back.
    pub links: SkillsApplyResult,
    pub takeover: Vec<ExpertLink>,
    pub held: Vec<NameHeld>,
    /// The agent's copies the user changed that go with the plugin's skill
    /// (each copied into the backups first).
    pub copies_to_take: Vec<String>,
    pub issues: Vec<Reason>,
}

impl OwnedPlan {
    /// The `ack`s the call needs, by member.
    pub fn acks(&self) -> BTreeMap<String, String> {
        self.links
            .ops
            .iter()
            .filter_map(|op| op.ack.clone().map(|ack| (op.skill.clone(), ack)))
            .collect()
    }
}

fn wire(agent: AgentType) -> String {
    agent.as_wire().into_owned()
}

pub(crate) fn engine_reason(issue: &SkillsIssue, skill: &str) -> Reason {
    let mut reason = Reason::new(&issue.code).param("name", skill.to_string());
    if let Some(path) = &issue.path {
        reason = reason.param("path", path.clone());
    }
    if !issue.agents.is_empty() {
        reason = reason.param(
            "agents",
            issue
                .agents
                .iter()
                .map(|agent| wire(*agent))
                .collect::<Vec<_>>()
                .join(","),
        );
    }
    if let Some(detail) = &issue.detail {
        reason = reason.detail(detail.clone());
    }
    reason
}

pub(crate) fn held_reason(held: &NameHeld) -> Reason {
    let by = serde_json::to_value(held.by)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_default();
    let mut reason = Reason::new(codes::NAME_TAKEN)
        .param("name", held.name.clone())
        .param("by", by)
        .param("path", held.path.clone());
    if let Some(plugin) = &held.plugin {
        reason = reason.param("plugin", plugin.clone());
    }
    reason
}

/// Copies of the plugin's members of `names` that `agent` has and that were
/// changed on the agent's side: (member, the copy, whether it is in a
/// directory of the agent's own).
fn changed_copies(
    own: &SkillsCtx,
    agent: AgentType,
    names: &[String],
) -> Vec<(String, PathBuf, bool)> {
    let world = World::load(own);
    let mut out = Vec::new();
    for name in names {
        for (path, _, role, entry) in world.entries_of(agent, name) {
            if matches!(entry, Entry::CodegCopy { ref skill, matches: false, .. } if skill == name)
            {
                out.push((name.clone(), path, role == DirRole::Own));
            }
        }
    }
    out
}

/// A changed copy in a directory other agents read: taking it would take
/// their change too, unasked. The caller refreshes or removes it first.
fn shared_changed_copies(changed: &[(String, PathBuf, bool)]) -> Vec<Reason> {
    changed
        .iter()
        .filter(|(_, _, own_dir)| !own_dir)
        .map(|(name, path, _)| {
            Reason::new(skill_codes::COPY_MODIFIED)
                .param("name", name.clone())
                .param("path", path.to_string_lossy().into_owned())
        })
        .collect()
}

fn taken_paths(changed: &[(String, PathBuf, bool)]) -> Vec<String> {
    changed
        .iter()
        .filter(|(_, _, own_dir)| *own_dir)
        .map(|(_, path, _)| path.to_string_lossy().into_owned())
        .collect()
}

/// The ops of one call, for `agent`: enable `wanted`, disable `dropped`.
fn ops(
    agent: AgentType,
    wanted: &[String],
    dropped: &[String],
    acks: &BTreeMap<String, String>,
) -> Vec<SkillOp> {
    let op = |skill: &String, action| SkillOp {
        skill: skill.clone(),
        agent,
        action,
        ack: acks.get(skill).cloned(),
        replace_modified: false,
    };
    wanted
        .iter()
        .map(|skill| op(skill, SkillAction::Enable))
        .chain(dropped.iter().map(|skill| op(skill, SkillAction::Disable)))
        .collect()
}

/// Each copy of the plugin's in `changed` (the user changed it; in a
/// directory of the agent's own) copied into the backups, and its removal
/// planned — carried out with the call's link request, all or nothing — so
/// the plugin's skill does not stay behind in the agent, and the change is
/// not lost. `None` when a backup could not be made (the report says why;
/// those made are dropped again).
fn changed_copies_out(
    own: &SkillsCtx,
    agent: AgentType,
    changed: &[(String, PathBuf, bool)],
    report: &mut OwnedReport,
) -> Option<CopiesOut> {
    let mut out = CopiesOut::default();
    for (name, path, _) in changed {
        match crate::skills::backups::copy_into_backups(
            own,
            path,
            name,
            Some(&crate::skills::apply::agent_label(agent)),
        ) {
            Ok(backup) => out.backups.push((name.clone(), path.clone(), backup)),
            Err(error) => {
                // Every copy is still where it was: these are spares.
                out.drop_backups(own);
                report.outcome = OwnedOutcome::WriteFailed;
                report.issues.push(io_reason(codes::IO_ERROR, name, &error));
                return None;
            }
        }
        out.plan.steps.push(Step::RemoveCopy {
            path: path.clone(),
            skill: name.clone(),
        });
        out.paths.push(path.to_string_lossy().into_owned());
    }
    Some(out)
}

/// Changed copies on their way out: the removals, and their backups.
#[derive(Default)]
struct CopiesOut {
    plan: Plan,
    paths: Vec<String>,
    /// (member, the copy, its backup).
    backups: Vec<(String, PathBuf, PathBuf)>,
}

impl CopiesOut {
    /// The request failed: a backup whose copy is back in place, exactly
    /// as backed up, is a spare and goes; any other stays, and is returned
    /// (its copy could not be put back: the backup is what keeps the
    /// change).
    fn drop_backups(&self, own: &SkillsCtx) -> Vec<PathBuf> {
        use crate::skills::fsio::hash_skill_dir;
        let mut kept = Vec::new();
        for (name, copy, backup) in &self.backups {
            let back = fs::symlink_metadata(copy).is_ok_and(|meta| meta.is_dir())
                && match (hash_skill_dir(copy, name), hash_skill_dir(backup, name)) {
                    (Ok(live), Ok(kept)) => live == kept,
                    _ => false,
                };
            if back {
                let _ = fs::remove_dir_all(backup);
                crate::skills::backups::tidy(own, name);
            } else {
                kept.push(backup.clone());
            }
        }
        kept
    }
}

/// Every op's `ack` as confirmed — else the reasons.
fn unconfirmed(preflight: &SkillsApplyResult, acks: &BTreeMap<String, String>) -> Vec<Reason> {
    preflight
        .ops
        .iter()
        .filter_map(|op| {
            let wanted = op.ack.as_ref()?;
            let code = match acks.get(&op.skill) {
                Some(sent) if sent == wanted => return None,
                Some(_) => codes::EFFECTS_CHANGED,
                None => codes::ACKNOWLEDGEMENT_REQUIRED,
            };
            Some(Reason::new(code).param("name", op.skill.clone()))
        })
        .collect()
}

fn blocked(preflight: &SkillsApplyResult) -> Vec<Reason> {
    preflight
        .ops
        .iter()
        .filter(|op| op.status == OpStatus::Blocked)
        .flat_map(|op| {
            op.issues
                .iter()
                .map(|issue| engine_reason(issue, &op.skill))
                .collect::<Vec<_>>()
        })
        .collect()
}

/// The members of the plugin's store, as its manifest lists them — each
/// entry the plugin's own (a store reached under another spelling of the
/// name, on a file system that ignores case, is not).
fn load_set(own: &SkillsCtx) -> Result<Manifest, Reason> {
    let manifest = manifest::load_for_write(&own.store).map_err(|error| manifest_reason(&error))?;
    let owner = own.owner.as_deref();
    if let Some((name, entry)) = manifest
        .skills
        .iter()
        .find(|(_, entry)| entry.plugin.as_deref() != owner)
    {
        return Err(Reason::new(owned_codes::OWNED_BY_OTHER)
            .param("name", name.clone())
            .param("plugin", entry.plugin.clone().unwrap_or_default()));
    }
    Ok(manifest)
}

/// The agents that have each member: any link or copy of the plugin's (live
/// or broken) under its name in a directory they read.
fn linkers(
    own: &SkillsCtx,
    names: impl IntoIterator<Item = String>,
) -> BTreeMap<String, Vec<AgentType>> {
    let world = World::load(own);
    let mut out = BTreeMap::new();
    for name in names {
        let mut agents: Vec<AgentType> = Vec::new();
        for dir in own.all_dirs() {
            let path = dir.join(&name);
            let ours = matches!(
                world.entry(&path),
                Entry::CodegLink { ref skill, .. } | Entry::CodegCopy { ref skill, .. } if *skill == name
            );
            if ours {
                for reader in own
                    .dir_info(&dir)
                    .map(|i| i.readers.clone())
                    .unwrap_or_default()
                {
                    if !agents.contains(&reader) {
                        agents.push(reader);
                    }
                }
            }
        }
        agents.sort();
        out.insert(name, agents);
    }
    out
}

fn check_agent(ctx: &SkillsCtx, agent: AgentType) -> Option<Reason> {
    (ctx.agent(agent).is_none() || ctx.link_dir(agent).is_none())
        .then(|| Reason::new(codes::AGENT_UNSUPPORTED).param("agent", wire(agent)))
}

/// What [`install_owned`] / [`replace_owned`] would do for `agent` with the
/// members `names` (and the store's members not among them dropped for
/// it).
pub(crate) fn plan_owned(
    ctx: &SkillsCtx,
    owner: &PluginOwner,
    agent: AgentType,
    names: &[String],
) -> OwnedPlan {
    let own = ctx.owned_by(owner);
    let mut issues: Vec<Reason> = check_agent(ctx, agent).into_iter().collect();
    let current = match load_set(&own) {
        Ok(manifest) => manifest.skills.into_keys().collect::<Vec<_>>(),
        Err(reason) => {
            issues.push(reason);
            Vec::new()
        }
    };
    let dropped: Vec<String> = current.into_iter().filter(|n| !names.contains(n)).collect();
    let changed = changed_copies(&own, agent, &dropped);
    issues.extend(shared_changed_copies(&changed));
    let found = conflicts(ctx, Some(owner), agent, names);
    // As the links will be once the Experts pack's are taken over: the
    // `ack`s are those of the call made after that.
    let taken: Vec<PathBuf> = found
        .takeover
        .iter()
        .map(|link| PathBuf::from(&link.path))
        .collect();
    let links = preflight_without(
        &own,
        ops(agent, names, &dropped, &BTreeMap::new()),
        names.iter().cloned().collect(),
        &taken,
    );
    OwnedPlan {
        plugin: owner.name().to_string(),
        agent,
        links,
        takeover: found.takeover,
        held: found.held,
        copies_to_take: taken_paths(&changed),
        issues,
    }
}

/// What [`remove_owned`] would do for `agent`.
pub(crate) fn plan_remove_owned(
    ctx: &SkillsCtx,
    owner: &PluginOwner,
    agent: AgentType,
) -> OwnedPlan {
    let own = ctx.owned_by(owner);
    let mut issues = Vec::new();
    let current = match load_set(&own) {
        Ok(manifest) => manifest.skills.into_keys().collect::<Vec<_>>(),
        Err(reason) => {
            issues.push(reason);
            Vec::new()
        }
    };
    let changed = changed_copies(&own, agent, &current);
    issues.extend(shared_changed_copies(&changed));
    let links = preflight_pending(
        &own,
        ops(agent, &[], &current, &BTreeMap::new()),
        BTreeSet::new(),
    );
    OwnedPlan {
        plugin: owner.name().to_string(),
        agent,
        links,
        takeover: Vec::new(),
        held: Vec::new(),
        copies_to_take: taken_paths(&changed),
        issues,
    }
}

/// [`plan_owned`] for several agents one operation does one after the
/// other, in `agents`' order, once every one's Experts links are taken
/// over: each agent's links as they will be when its call comes — the
/// agents before it done — so its `ack`s are the ones that call gets (an
/// agent before it may have put the members where it looks, or into a
/// directory a third agent reads).
pub(crate) fn plan_owned_in_turn(
    ctx: &SkillsCtx,
    owner: &PluginOwner,
    agents: &[AgentType],
    names: &[String],
) -> Vec<OwnedPlan> {
    let mut plans: Vec<OwnedPlan> = agents
        .iter()
        .map(|agent| plan_owned(ctx, owner, *agent, names))
        .collect();
    if plans.len() < 2 {
        return plans;
    }
    let own = ctx.owned_by(owner);
    let current = load_set(&own)
        .map(|manifest| manifest.skills.into_keys().collect::<Vec<_>>())
        .unwrap_or_default();
    let dropped: Vec<String> = current.into_iter().filter(|n| !names.contains(n)).collect();
    let taken: Vec<PathBuf> = plans
        .iter()
        .flat_map(|plan| plan.takeover.iter().map(|link| PathBuf::from(&link.path)))
        .collect();
    let all = agents
        .iter()
        .flat_map(|agent| ops(*agent, names, &dropped, &BTreeMap::new()))
        .collect();
    let together = preflight_without(&own, all, names.iter().cloned().collect(), &taken);
    for plan in plans.iter_mut() {
        plan.links = of_agent(&together, plan.agent);
    }
    plans
}

/// [`plan_remove_owned`] for several agents one operation does one after
/// the other, in `agents`' order: each agent's removal as it will be when
/// its call comes.
pub(crate) fn plan_remove_owned_in_turn(
    ctx: &SkillsCtx,
    owner: &PluginOwner,
    agents: &[AgentType],
) -> Vec<OwnedPlan> {
    let mut plans: Vec<OwnedPlan> = agents
        .iter()
        .map(|agent| plan_remove_owned(ctx, owner, *agent))
        .collect();
    if plans.len() < 2 {
        return plans;
    }
    let own = ctx.owned_by(owner);
    let current = load_set(&own)
        .map(|manifest| manifest.skills.into_keys().collect::<Vec<_>>())
        .unwrap_or_default();
    let all = agents
        .iter()
        .flat_map(|agent| ops(*agent, &[], &current, &BTreeMap::new()))
        .collect();
    let together = preflight_pending(&own, all, BTreeSet::new());
    for plan in plans.iter_mut() {
        plan.links = of_agent(&together, plan.agent);
    }
    plans
}

/// One agent's ops of a preflight made for several.
fn of_agent(together: &SkillsApplyResult, agent: AgentType) -> SkillsApplyResult {
    let ops: Vec<_> = together
        .ops
        .iter()
        .filter(|op| op.agent == agent)
        .cloned()
        .collect();
    SkillsApplyResult {
        outcome: together.outcome,
        ok: ops.iter().all(|op| op.status != OpStatus::Blocked),
        ops,
        issues: together.issues.clone(),
    }
}

/// One more agent for the plugin's skills. See the module docs.
pub(crate) fn install_owned(
    ctx: &SkillsCtx,
    held: &SkillsGuard,
    owner: &PluginOwner,
    agent: AgentType,
    origin: &OwnedOrigin,
    members: &[OwnedMember],
    acks: &BTreeMap<String, String>,
) -> OwnedReport {
    put(ctx, held, owner, agent, origin, members, acks, false)
}

/// An update of the plugin's skills, for one agent. See the module docs.
pub(crate) fn replace_owned(
    ctx: &SkillsCtx,
    held: &SkillsGuard,
    owner: &PluginOwner,
    agent: AgentType,
    origin: &OwnedOrigin,
    members: &[OwnedMember],
    acks: &BTreeMap<String, String>,
) -> OwnedReport {
    put(ctx, held, owner, agent, origin, members, acks, true)
}

/// A member's files as installed (`SKILL.md` rewritten), or why not.
fn prepare(member: &OwnedMember) -> Result<(Vec<PackageFile>, Rewrites), Reason> {
    let mut files = member.files.clone();
    let Some(skill_md) = files.iter_mut().find(|file| file.path == "SKILL.md") else {
        return Err(Reason::new(codes::SKILL_MD_MISSING).param("name", member.name.clone()));
    };
    match frontmatter::rewrite(&skill_md.bytes, &member.name, false) {
        Ok(done) => {
            skill_md.bytes = done.bytes;
            Ok((files, done.rewrites))
        }
        Err(detail) => Err(Reason::new(codes::SKILL_MD_INVALID)
            .param("name", member.name.clone())
            .detail(detail)),
    }
}

fn digest(files: &[PackageFile]) -> BTreeMap<String, String> {
    files
        .iter()
        .map(|file| (file.path.clone(), sha256_hex(&file.bytes)))
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn put(
    ctx: &SkillsCtx,
    _held: &SkillsGuard,
    owner: &PluginOwner,
    agent: AgentType,
    origin: &OwnedOrigin,
    members: &[OwnedMember],
    acks: &BTreeMap<String, String>,
    replace: bool,
) -> OwnedReport {
    let own = ctx.owned_by(owner);
    let report = OwnedReport::new(owner, agent);

    // The call itself.
    if let Some(reason) = check_agent(ctx, agent) {
        return report.refused(vec![reason]);
    }
    let mut issues = Vec::new();
    let mut prepared: Vec<(String, Vec<PackageFile>, Rewrites)> = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for member in members {
        if !names::is_valid(&member.name) {
            issues.push(Reason::new(codes::NAME_INVALID).param("name", member.name.clone()));
            continue;
        }
        if !seen.insert(member.name.to_ascii_lowercase()) {
            issues.push(
                Reason::new(owned_codes::MEMBER_DUPLICATE).param("name", member.name.clone()),
            );
            continue;
        }
        if let Some(bad) = member.files.iter().find(|file| !safe_path(&file.path)) {
            issues.push(Reason::new(codes::UNSAFE_PATH).param("path", bad.path.clone()));
            continue;
        }
        match prepare(member) {
            Ok((files, rewrites)) => prepared.push((member.name.clone(), files, rewrites)),
            Err(reason) => issues.push(reason),
        }
    }
    if !issues.is_empty() {
        return report.refused(issues);
    }
    let names: Vec<String> = prepared.iter().map(|(name, _, _)| name.clone()).collect();
    let current = match load_set(&own) {
        Ok(manifest) => manifest,
        Err(reason) => return report.refused(vec![reason]),
    };
    let dropped: Vec<String> = current
        .skills
        .keys()
        .filter(|name| !names.contains(name))
        .cloned()
        .collect();

    // What is in the way, in this agent (and whoever reads its directory).
    let mut report = report;
    let found = conflicts(ctx, Some(owner), agent, &names);
    if !found.takeover.is_empty() || !found.held.is_empty() {
        let mut issues: Vec<Reason> = found.held.iter().map(held_reason).collect();
        if !found.takeover.is_empty() {
            let mut taken: Vec<String> = found.takeover.iter().map(|l| l.name.clone()).collect();
            taken.sort();
            taken.dedup();
            issues.push(Reason::new(owned_codes::EXPERTS_LINKED).param("names", taken.join(",")));
        }
        report.takeover = found.takeover;
        report.held = found.held;
        return report.refused(issues);
    }

    // One more agent: the store must hold this very set when another agent
    // has it.
    if !replace {
        let differs = !dropped.is_empty()
            || prepared.iter().any(|(name, files, _)| {
                current.skills.get(name).is_none_or(|entry| {
                    entry.files != digest(files) || !modes_match(&own.skill_path(name), files)
                })
            });
        let others = linkers(&own, current.skills.keys().cloned())
            .into_values()
            .flatten()
            .any(|linker| linker != agent);
        if differs && !current.skills.is_empty() && others {
            return report.refused(vec![Reason::new(owned_codes::OWNED_SET_DIFFERS)]);
        }
    }

    let changed = changed_copies(&own, agent, &dropped);
    let shared = shared_changed_copies(&changed);
    if !shared.is_empty() {
        return report.refused(shared);
    }

    // The links, as confirmed — checked before anything moves.
    let preflight = preflight_pending(
        &own,
        ops(agent, &names, &dropped, acks),
        names.iter().cloned().collect(),
    );
    let stop = blocked(&preflight);
    if !stop.is_empty() {
        report.links = Some(preflight);
        return report.refused(stop);
    }
    let missing = unconfirmed(&preflight, acks);
    if !missing.is_empty() {
        report.outcome = OwnedOutcome::AcknowledgementRequired;
        report.issues = missing;
        report.links = Some(preflight);
        return report;
    }

    // The store: each member journaled on its own.
    for (name, files, rewrites) in &prepared {
        report.rewrites.insert(name.clone(), rewrites.clone());
        let before = current.skills.get(name).cloned();
        match put_member(&own, origin, owner, name, files, rewrites, before) {
            Ok(Put::Unchanged) => {}
            Ok(Put::Restamped) => {
                report.restamped.push(name.clone());
                report.store_changed = true;
            }
            Ok(Put::Added) => {
                report.added.push(name.clone());
                report.store_changed = true;
            }
            Ok(Put::Replaced(backup)) => {
                report.replaced.push(name.clone());
                report.store_changed = true;
                report.backups.extend(backup);
            }
            Err(failure) => {
                report.outcome = OwnedOutcome::WriteFailed;
                report.store_changed |= failure.changed;
                report.issues.push(failure.reason);
                report.kept_paths.extend(failure.kept);
                return report;
            }
        }
    }
    // Codeg's copies of every member that are behind the store (not only
    // those replaced now: a refresh that failed before is tried again).
    let mut stale_copies = false;
    for name in &names {
        let (copies, touched) = refresh_copies(&own, name);
        report.copies_refreshed.extend(copies.refreshed);
        if !copies.problems.is_empty() {
            stale_copies = true;
            report.issues.push(
                Reason::new(owned_codes::COPIES_NOT_REFRESHED)
                    .param("name", name.clone())
                    .detail(copies.problems.join("; ")),
            );
        }
        report.touched.extend(touched);
    }

    // The agent's links: one engine request (its changed copies of dropped
    // members go in it, first).
    let Some(out) = changed_copies_out(&own, agent, &changed, &mut report) else {
        return report;
    };
    if !link(&own, agent, &names, &dropped, acks, out, &mut report) {
        return report;
    }

    // Members dropped from the set that nobody links any more.
    sweep(&own, &dropped, &mut report);
    if stale_copies {
        report.outcome = OwnedOutcome::WriteFailed;
    }
    finish_report(&mut report);
    report
}

/// The agent's links of `wanted` made and of `dropped` taken out, as one
/// request; `false` when it did not go through (the report says why).
fn link(
    own: &SkillsCtx,
    agent: AgentType,
    wanted: &[String],
    dropped: &[String],
    acks: &BTreeMap<String, String>,
    copies: CopiesOut,
    report: &mut OwnedReport,
) -> bool {
    let (result, changed) = apply_after(
        own,
        &SkillsApplyRequest {
            ops: ops(agent, wanted, dropped, acks),
            preflight: false,
        },
        &copies.plan,
    );
    if result.ok {
        report.copies_taken.extend(copies.paths.iter().cloned());
        report.backups.extend(
            copies
                .backups
                .iter()
                .map(|(_, _, backup)| backup.to_string_lossy().into_owned()),
        );
    } else {
        for kept in copies.drop_backups(own) {
            let kept = kept.to_string_lossy().into_owned();
            report.backups.push(kept.clone());
            report.kept_paths.push(kept);
        }
    }
    report.touched.extend(changed.agents(own));
    for op in &result.ops {
        if op.status != OpStatus::Done {
            continue;
        }
        match op.action {
            SkillAction::Enable => report.linked.push(op.skill.clone()),
            SkillAction::Disable => report.unlinked.push(op.skill.clone()),
            _ => {}
        }
    }
    let ok = result.ok;
    if !ok {
        report.outcome = OwnedOutcome::WriteFailed;
        report
            .issues
            .extend(result.issues.iter().map(|issue| engine_reason(issue, "")));
        for op in &result.ops {
            report.issues.extend(
                op.issues
                    .iter()
                    .map(|issue| engine_reason(issue, &op.skill)),
            );
        }
    }
    report.links = Some(result);
    ok
}

/// Take out of the store every member of `names` that no agent links any
/// more; the others stay (`kept`). Then the store itself, once empty.
fn sweep(own: &SkillsCtx, names: &[String], report: &mut OwnedReport) {
    let linked = linkers(own, names.iter().cloned());
    for name in names {
        if linked.get(name).is_some_and(|agents| !agents.is_empty()) {
            report.kept.push(name.clone());
            continue;
        }
        match remove_member(own, name) {
            Ok(backup) => {
                report.removed.push(name.clone());
                report.store_changed = true;
                report.backups.extend(backup);
            }
            Err(failure) => {
                report.outcome = OwnedOutcome::WriteFailed;
                report.store_changed |= failure.changed;
                report.issues.push(failure.reason);
                report.kept_paths.extend(failure.kept);
                return;
            }
        }
    }
    tidy_store(own);
}

fn finish_report(report: &mut OwnedReport) {
    report.touched.sort();
    report.touched.dedup();
}

/// The agent's links of the plugin's skills out; then every member no
/// agent links out of the store, and the store once empty. See the module
/// docs.
pub(crate) fn remove_owned(
    ctx: &SkillsCtx,
    _held: &SkillsGuard,
    owner: &PluginOwner,
    agent: AgentType,
    acks: &BTreeMap<String, String>,
) -> OwnedReport {
    let own = ctx.owned_by(owner);
    let mut report = OwnedReport::new(owner, agent);
    if ctx.agent(agent).is_none() {
        return report.refused(vec![
            Reason::new(codes::AGENT_UNSUPPORTED).param("agent", wire(agent))
        ]);
    }
    let current = match load_set(&own) {
        Ok(manifest) => manifest,
        Err(reason) => return report.refused(vec![reason]),
    };
    let members: Vec<String> = current.skills.keys().cloned().collect();
    let changed = changed_copies(&own, agent, &members);
    let shared = shared_changed_copies(&changed);
    if !shared.is_empty() {
        return report.refused(shared);
    }
    let preflight = preflight_pending(&own, ops(agent, &[], &members, acks), BTreeSet::new());
    let stop = blocked(&preflight);
    if !stop.is_empty() {
        report.links = Some(preflight);
        return report.refused(stop);
    }
    let missing = unconfirmed(&preflight, acks);
    if !missing.is_empty() {
        report.outcome = OwnedOutcome::AcknowledgementRequired;
        report.issues = missing;
        report.links = Some(preflight);
        return report;
    }
    let Some(out) = changed_copies_out(&own, agent, &changed, &mut report) else {
        return report;
    };
    if !link(&own, agent, &[], &members, acks, out, &mut report) {
        return report;
    }
    sweep(&own, &members, &mut report);
    finish_report(&mut report);
    report
}

// ─── One member in the store ────────────────────────────────────────────

enum Put {
    Unchanged,
    Restamped,
    Added,
    Replaced(Option<String>),
}

struct MemberFailure {
    reason: Reason,
    /// The store had changed for good (the commit happened) before it.
    changed: bool,
    kept: Vec<String>,
}

fn failure(reason: Reason, changed: bool, kept: Vec<PathBuf>) -> MemberFailure {
    MemberFailure {
        reason,
        changed,
        kept: kept
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect(),
    }
}

fn io_reason(code: &str, name: &str, error: &std::io::Error) -> Reason {
    Reason::new(code)
        .param("name", name.to_string())
        .detail(error.to_string())
}

/// Put back what `tx` moved; the reason for the step that failed, with what
/// a failed rollback kept.
fn undone(tx: &Tx<'_>, reason: Reason) -> MemberFailure {
    match tx.rollback() {
        Ok(()) => failure(reason, false, Vec::new()),
        Err(rollback) => {
            let mut out = failure(reason, false, rollback.kept);
            out.reason = out.reason.param("rollback", rollback.error.to_string());
            out
        }
    }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// The member `name` in the plugin's store as `files`: left alone when it is
/// there exactly so; else staged, journaled, swapped in and committed (the
/// folder it replaces kept among the backups when the user changed it).
fn put_member(
    own: &SkillsCtx,
    origin: &OwnedOrigin,
    owner: &PluginOwner,
    name: &str,
    files: &[PackageFile],
    rewrites: &Rewrites,
    before: Option<ManifestEntry>,
) -> Result<Put, MemberFailure> {
    let digest = digest(files);
    let entry = |op: String| ManifestEntry {
        item_id: origin.item_id.clone(),
        item_ref: origin.item_ref.clone(),
        revision: origin.revision,
        version: origin.version.clone(),
        archive_sha256: origin.archive_sha256.clone(),
        source: origin.source.clone(),
        files: digest.clone(),
        rewrites: rewrites.clone(),
        state_sha256: origin.state_sha256.clone(),
        installed_at: now(),
        op,
        plugin: Some(owner.name().to_string()),
        extra: serde_json::Map::new(),
    };
    let live = own.skill_path(name);
    let had_old = fs::symlink_metadata(&live).is_ok();
    if let Some(recorded) = &before {
        let intact = had_old
            && recorded.files == digest
            && file_changes(&live, recorded).is_ok_and(|changes| changes.is_empty())
            && modes_match(&live, files);
        if intact {
            let same = recorded.item_id == origin.item_id
                && recorded.revision == origin.revision
                && recorded.state_sha256 == origin.state_sha256
                && recorded.rewrites == *rewrites
                && recorded.plugin.as_deref() == Some(owner.name());
            if same {
                return Ok(Put::Unchanged);
            }
            // The same files under a new revision: the entry alone.
            let mut manifest = manifest::load_for_write(&own.store)
                .map_err(|e| failure(manifest_reason(&e), false, Vec::new()))?;
            manifest
                .skills
                .insert(name.to_string(), entry(recorded.op.clone()));
            manifest::save(&own.store, &manifest).map_err(|e| {
                failure(
                    io_reason(codes::MANIFEST_WRITE_FAILED, name, &e),
                    false,
                    Vec::new(),
                )
            })?;
            return Ok(Put::Restamped);
        }
    }
    let keep_old = match (&before, had_old) {
        (Some(recorded), true) => file_changes(&live, recorded)
            .map(|changes| !changes.changed.is_empty() || !changes.added.is_empty())
            .unwrap_or(true),
        // A folder no entry knows (left by an interrupted operation): kept.
        (None, true) => true,
        _ => false,
    };
    let action = if before.is_some() {
        Action::Update
    } else {
        Action::Install
    };
    let journal = new_journal(
        action,
        name,
        &origin.item_id,
        before,
        None,
        had_old,
        keep_old,
    );
    let mut tx = Tx::begin(own, journal)
        .map_err(|e| failure(io_reason(codes::IO_ERROR, name, &e), false, Vec::new()))?;
    match tx.stage(files) {
        Ok(hash) => tx.journal.new_hash = Some(hash),
        Err(error) => {
            tx.discard();
            return Err(failure(
                io_reason(codes::IO_ERROR, name, &error),
                false,
                Vec::new(),
            ));
        }
    }
    tx.journal.after = Some(entry(tx.journal.op.clone()));
    if let Err(error) = tx.write_journal() {
        tx.discard();
        return Err(failure(
            io_reason(codes::IO_ERROR, name, &error),
            false,
            Vec::new(),
        ));
    }
    if let Err(error) = tx.swap() {
        return Err(undone(&tx, io_reason(codes::IO_ERROR, name, &error)));
    }
    if let Err(error) = tx.commit() {
        return Err(undone(
            &tx,
            io_reason(codes::MANIFEST_WRITE_FAILED, name, &error),
        ));
    }
    let backup = match tx.finish() {
        Ok(kept) => kept.map(|path| path.to_string_lossy().into_owned()),
        Err(error) => {
            // Put in; what is left is the next start's to clean.
            tracing::warn!(
                "[Harness plugins] {name}: cleaning up after the swap failed ({error}); the next start finishes it"
            );
            None
        }
    };
    Ok(if action == Action::Install {
        Put::Added
    } else {
        Put::Replaced(backup)
    })
}

/// Every file's executable bit on disk as `files` give it (a revision may
/// change a mode alone). Where there are no such bits, always.
fn modes_match(live: &Path, files: &[PackageFile]) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        files.iter().all(|file| {
            fs::symlink_metadata(live.join(&file.path))
                .is_ok_and(|meta| (meta.permissions().mode() & 0o111 != 0) == file.executable)
        })
    }
    #[cfg(not(unix))]
    {
        let _ = (live, files);
        true
    }
}

/// The member `name` out of the plugin's store and its manifest (journaled;
/// a folder the user changed is kept among the backups).
fn remove_member(own: &SkillsCtx, name: &str) -> Result<Option<String>, MemberFailure> {
    let manifest = manifest::load_for_write(&own.store)
        .map_err(|e| failure(manifest_reason(&e), false, Vec::new()))?;
    let Some(before) = manifest.skills.get(name).cloned() else {
        return Ok(None);
    };
    let live = own.skill_path(name);
    let had_old = fs::symlink_metadata(&live).is_ok();
    let keep_old = had_old
        && file_changes(&live, &before)
            .map(|changes| !changes.changed.is_empty() || !changes.added.is_empty())
            .unwrap_or(true);
    let journal = new_journal(
        Action::Uninstall,
        name,
        &before.item_id.clone(),
        Some(before),
        None,
        had_old,
        keep_old,
    );
    let tx = Tx::begin(own, journal)
        .map_err(|e| failure(io_reason(codes::IO_ERROR, name, &e), false, Vec::new()))?;
    if let Err(error) = tx.write_journal() {
        tx.discard();
        return Err(failure(
            io_reason(codes::IO_ERROR, name, &error),
            false,
            Vec::new(),
        ));
    }
    if let Err(error) = tx.swap() {
        return Err(undone(&tx, io_reason(codes::IO_ERROR, name, &error)));
    }
    if let Err(error) = tx.commit() {
        return Err(undone(
            &tx,
            io_reason(codes::MANIFEST_WRITE_FAILED, name, &error),
        ));
    }
    match tx.finish() {
        Ok(kept) => Ok(kept.map(|path| path.to_string_lossy().into_owned())),
        Err(error) => {
            tracing::warn!(
                "[Harness plugins] {name}: cleaning up after the removal failed ({error}); the next start finishes it"
            );
            Ok(None)
        }
    }
}

/// The plugin's store, once it holds no member and no link of its own is
/// recorded: its manifest and record go, then the folder (and `.plugins`)
/// when nothing else is left in it.
fn tidy_store(own: &SkillsCtx) {
    let Ok(manifest) = manifest::load(&own.store) else {
        return;
    };
    if !manifest.skills.is_empty() {
        return;
    }
    let record = crate::skills::record::LinkRecord::load(&own.store);
    if record.problem.is_some() || record.entries().next().is_some() {
        return;
    }
    let others = crate::skills::fsio::child_names(&own.store)
        .into_iter()
        .any(|name| {
            name != crate::skills::provenance::HARNESS_MANIFEST
                && name != crate::skills::record::RECORD_FILE
        });
    if others {
        return;
    }
    let _ = fs::remove_file(manifest::path(&own.store));
    let _ = fs::remove_file(crate::skills::record::record_path(&own.store));
    crate::skills::fsio::remove_if_empty(&own.store);
    crate::skills::fsio::remove_if_empty(&own.plugins_root);
}
