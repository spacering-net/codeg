//! Skills a Harness plugin owns: the member skills of a plugin installed as
//! its skills only (plan "skills only", decision 1: copied into Codeg's
//! skill store, owned by the plugin, managed only as a whole).
//!
//! **Where they are.** Each plugin has a store of its own inside Codeg's:
//!
//! ```text
//! ~/.codeg/skills/                       Codeg's store (the packs, Custom, Harness skills)
//!   brainstorming/                       the Experts pack's skill
//!   .plugins/<install name>/             the plugin's own store
//!     brainstorming/                     its member skill of the same name
//!     .manifest.harness.json             its members (each with `plugin`)
//!     .links.json                        the links and copies made of them
//!     .codeg-staging/                    its operations' journals
//! ```
//!
//! Working on a plugin's members is the engine as it is, over that store
//! ([`SkillsCtx::owned_by`]): the store id is the skill's own name, so the
//! link in an agent's directory has the skill's name, while nothing in
//! Codeg's store — the Experts pack's `brainstorming`, always extracted at
//! startup — is ever touched or blocked by it. `.plugins` is dot-prefixed:
//! no listing of Codeg's store sees it, no skill id can name it, and Codeg's
//! backup takes it with the store (its `.codeg-staging` aside).
//!
//! **Whose it is.** Seen from Codeg's store (or another plugin's), a link
//! into a plugin's store, or a copy that plugin's record says it made, is
//! [`Entry::Owned`]: the Skills section's link, unlink, repair and adopt,
//! and the Skills page's delete, refuse it (`plugin_owned`). Only a caller
//! holding the plugin's [`PluginOwner`] — the plugins module, under the
//! plugins lock — gets the context that changes it.
//!
//! **One provider per name per agent.** Before a plugin's skill goes into an
//! agent, whatever else that agent reads under the name is in the way
//! ([`conflicts`]): a link of the Experts pack is a takeover candidate (the
//! plugin is superpowers, the pack is superpowers: [`unlink_experts`] takes
//! those links out, [`relink_experts`] puts them back — each touching only
//! the pack's own links, and leaving anything the user changed since as it
//! is); anything else is "name taken".

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::harness::plugins::ctx::{is_valid_install_name, InstallName};
use crate::harness::plugins::lock::PluginsGuard;
use crate::models::agent::AgentType;

use super::apply::{execute, locate_in_agent_dir, Changed, Plan, Step};
use super::fsio::entry_key;
use super::link::{inspect, LinkMode, RawEntry};
use super::lock::SkillsGuard;
use super::model::{ChangeKind, PathChange, SkillOrigin, SkillsIssue};
use super::record::LinkRecord;
use super::world::{Entry, World};
use super::{SkillsCtx, StorePaths};

/// The folder of Codeg's store that holds the plugins' own stores.
pub(crate) const PLUGINS_DIR: &str = ".plugins";

/// The right to change one plugin's member skills: only the plugins module
/// makes one, holding the plugins lock (lock order: plugins, then skills).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginOwner {
    name: String,
}

impl PluginOwner {
    pub(crate) fn new(_held: &PluginsGuard, name: &InstallName) -> Self {
        Self {
            name: name.as_str().to_string(),
        }
    }

    /// The plugin's install name.
    pub fn name(&self) -> &str {
        &self.name
    }
}

impl SkillsCtx {
    /// The engine over `owner`'s own store: its links, copies, record,
    /// manifest and journals. The same agents, lock and links.
    pub(crate) fn owned_by(&self, owner: &PluginOwner) -> SkillsCtx {
        self.over_plugin_store(owner.name())
    }
}

/// The install names that have a store of their own here: real folders
/// (never a link) under `.plugins` whose name is an install name.
pub(crate) fn plugin_store_names(plugins_root: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(plugins_root) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|entry| {
            fs::symlink_metadata(entry.path())
                .is_ok_and(|meta| meta.is_dir() && !meta.file_type().is_symlink())
        })
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| is_valid_install_name(name))
        .collect();
    names.sort();
    names
}

/// [`plugin_store_names`] of `ctx`'s Codeg store.
pub(crate) fn plugin_stores(ctx: &SkillsCtx) -> Vec<String> {
    plugin_store_names(&ctx.plugins_root)
}

/// A copy a plugin's record says it made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OwnedCopy {
    pub plugin: String,
    pub skill: String,
    /// When it was made (RFC 3339): of two records claiming one folder —
    /// one of them stale, its copy since removed and another made there —
    /// the newer is right.
    pub created_at: String,
}

/// What tells a plugin's entry in an agent's directory: the plugins' stores
/// (links into them) and their records (copies).
#[derive(Debug, Clone)]
pub(crate) struct OwnedIndex {
    plugins: StorePaths,
    copies: BTreeMap<PathBuf, OwnedCopy>,
    /// In a plugin's own view: the copies Codeg's store's record claims
    /// (entry → when made), which are not the plugin's.
    main_copies: BTreeMap<PathBuf, String>,
    /// The plugin whose own view this is: its entries are not "owned" there.
    except: Option<String>,
}

impl OwnedIndex {
    pub fn load(plugins_root: &Path, except: Option<&str>) -> Self {
        let mut copies = BTreeMap::new();
        for name in plugin_store_names(plugins_root) {
            if except == Some(name.as_str()) {
                continue;
            }
            let record = LinkRecord::load(&plugins_root.join(&name));
            for entry in record.entries().filter(|e| e.mode == LinkMode::Copy) {
                let claim = OwnedCopy {
                    plugin: name.clone(),
                    skill: entry.skill.clone(),
                    created_at: entry.created_at.clone(),
                };
                let key = entry_key(Path::new(&entry.path));
                match copies.get(&key) {
                    Some(newer) if newer_claim(newer, &claim) => {}
                    _ => {
                        copies.insert(key, claim);
                    }
                }
            }
        }
        let mut main_copies = BTreeMap::new();
        if except.is_some() {
            if let Some(main) = plugins_root.parent() {
                for entry in LinkRecord::load(main)
                    .entries()
                    .filter(|e| e.mode == LinkMode::Copy)
                {
                    main_copies.insert(entry_key(Path::new(&entry.path)), entry.created_at.clone());
                }
            }
        }
        Self {
            plugins: StorePaths::of(plugins_root),
            copies,
            main_copies,
            except: except.map(str::to_string),
        }
    }

    /// The plugin and member a link leads into — or, dangling, points into.
    pub fn link(&self, target: Option<&Path>, resolved: Option<&Path>) -> Option<(String, String)> {
        let member = |path: &Path| -> Option<(String, String)> {
            let plugin = self.plugins.child_of(path.parent()?)?;
            if self.except.as_deref() == Some(plugin.as_str()) || !is_valid_install_name(&plugin) {
                return None;
            }
            let skill = path.file_name()?.to_string_lossy().into_owned();
            (!skill.starts_with('.')).then_some((plugin, skill))
        };
        match resolved {
            Some(real) => member(real),
            None => target.and_then(member),
        }
    }

    /// The plugin copy the folder at `path` is — also when `path` spells
    /// the folder's name in another case (a file system that ignores case).
    pub fn copy(&self, path: &Path) -> Option<&OwnedCopy> {
        claim_at(&self.copies, path)
    }

    /// In a plugin's own view: when Codeg's store's record says it made a
    /// copy at `path` (RFC 3339).
    pub fn main_copy(&self, path: &Path) -> Option<&String> {
        claim_at(&self.main_copies, path)
    }
}

/// The claim on the entry at `path` — also when `path` spells its name in
/// another case (a file system that ignores case).
fn claim_at<'a, T>(claims: &'a BTreeMap<PathBuf, T>, path: &Path) -> Option<&'a T> {
    let key = entry_key(path);
    if let Some(found) = claims.get(&key) {
        return Some(found);
    }
    let name = key.file_name()?.to_string_lossy().into_owned();
    claims.iter().find_map(|(other, claim)| {
        let alike = other.parent() == key.parent()
            && other
                .file_name()
                .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(&name));
        (alike && same_entry(other, path)).then_some(claim)
    })
}

/// Whether `a` was made after `b` (RFC 3339 times; an unreadable one is
/// older).
pub(crate) fn newer_claim(a: &OwnedCopy, b: &OwnedCopy) -> bool {
    newer_time(&a.created_at, &b.created_at)
}

pub(crate) fn newer_time(a: &str, b: &str) -> bool {
    let parse = |t: &str| chrono::DateTime::parse_from_rfc3339(t).ok();
    match (parse(a), parse(b)) {
        (Some(a), Some(b)) => a > b,
        (Some(_), None) => true,
        _ => false,
    }
}

/// Whether two spellings name one entry on disk.
fn same_entry(a: &Path, b: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (fs::symlink_metadata(a), fs::symlink_metadata(b)) {
            (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
            _ => false,
        }
    }
    #[cfg(not(unix))]
    {
        // Windows' file systems ignore case.
        fs::symlink_metadata(a).is_ok() && fs::symlink_metadata(b).is_ok()
    }
}

/// The plugin whose member the entry at `path` is (a link into its store,
/// or its copy), seen from Codeg's store.
pub(crate) fn plugin_of_entry(ctx: &SkillsCtx, path: &Path) -> Option<String> {
    let index = OwnedIndex::load(&ctx.plugins_root, ctx.owner.as_deref());
    match inspect(path) {
        RawEntry::Link { target, resolved } => index
            .link(target.as_deref(), resolved.as_deref())
            .map(|(plugin, _)| plugin),
        RawEntry::Dir => index.copy(path).map(|claim| claim.plugin.clone()),
        _ => None,
    }
}

/// The record of Codeg's store with every plugin's copies beside its own:
/// what the startup's recovery of agent-side copy operations reads (it
/// cannot tell whose operation it is finishing). Read only — never saved.
pub(crate) fn record_with_owned_copies(ctx: &SkillsCtx) -> LinkRecord {
    let mut record = LinkRecord::load(&ctx.store);
    for name in plugin_stores(ctx) {
        let owned = LinkRecord::load(&ctx.plugins_root.join(&name));
        record.borrow_copies(&owned);
    }
    record
}

// ─── What stands in a plugin's way in an agent ─────────────────────────

/// A link (or a copy, where no link could be made) of the Experts pack's
/// skill `name` in an agent's directory: what a plugin providing the same
/// skill takes out ([`unlink_experts`]) and gives back ([`relink_experts`]).
/// Serialized as is into the plugins record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExpertLink {
    pub name: String,
    /// The entry: `<agent skill directory>/<name>`.
    pub path: String,
    /// A copy Codeg made (no link could be made there).
    #[serde(default)]
    pub copy: bool,
    /// Every agent that reads the directory: who stops (and starts again)
    /// seeing the pack's skill with it.
    #[serde(default)]
    pub agents: Vec<AgentType>,
}

/// What holds a name a plugin's skill would take in an agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HeldBy {
    /// Codeg's link (or copy) of a skill from Harness (a standalone skill —
    /// a former member installed on its own, say).
    Harness,
    /// Codeg's link of a Custom skill.
    Custom,
    /// Codeg's link of a pack's skill that is not taken over (another pack,
    /// or the Experts pack's copy changed on the agent's side).
    Pack,
    /// Another plugin's member skill.
    Plugin,
    /// Something of the agent's or the user's own: a folder, a file, a link
    /// elsewhere, a broken link.
    Agent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NameHeld {
    pub name: String,
    pub path: String,
    pub by: HeldBy,
    /// `plugin`: which.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin: Option<String>,
    /// The agents that read that directory.
    pub agents: Vec<AgentType>,
}

/// Everything under the names in the way of a plugin's skills for one
/// agent.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Conflicts {
    /// The Experts pack's own links: taken out first, given back later.
    pub takeover: Vec<ExpertLink>,
    /// Anything else: the plugin's skill cannot go in ("name taken").
    pub held: Vec<NameHeld>,
}

/// The agents that see what goes into `agent`'s link directory: the agent,
/// and every other agent that reads the directory when it is shared.
pub(crate) fn audience(ctx: &SkillsCtx, agent: AgentType) -> Vec<AgentType> {
    let mut out = vec![agent];
    if let Some(info) = ctx.link_dir(agent).and_then(|(dir, _)| ctx.dir_info(&dir)) {
        for reader in &info.readers {
            if !out.contains(reader) {
                out.push(*reader);
            }
        }
    }
    out
}

/// What stands in the way of `names` for `agent` (and every agent that
/// reads its link directory): whatever any of them reads under one of the
/// names that is not `owner`'s own member of that name. `owner` `None`:
/// nothing is the caller's own.
pub(crate) fn conflicts(
    ctx: &SkillsCtx,
    owner: Option<&PluginOwner>,
    agent: AgentType,
    names: &[String],
) -> Conflicts {
    let main = World::load(ctx);
    let own_ctx = owner.map(|owner| ctx.owned_by(owner));
    let own = own_ctx.as_ref().map(|own_ctx| {
        World::load_pending(own_ctx, names.iter().cloned().collect::<BTreeSet<_>>())
    });
    let mut out = Conflicts::default();
    let mut seen: BTreeSet<PathBuf> = BTreeSet::new();
    for reader in audience(ctx, agent) {
        for name in names {
            for (path, dir, _, entry) in main.entries_of(reader, name) {
                if !seen.insert(entry_key(&path)) {
                    continue;
                }
                if let Some(own) = &own {
                    if matches!(
                        own.entry(&path),
                        Entry::CodegLink { ref skill, .. } | Entry::CodegCopy { ref skill, .. }
                            if skill == name
                    ) {
                        continue;
                    }
                }
                let agents = ctx
                    .dir_info(&dir)
                    .map(|info| info.readers.clone())
                    .unwrap_or_default();
                if let Some(link) = expert_link(&main, name, &path, &entry, &agents) {
                    out.takeover.push(link);
                    continue;
                }
                let (by, plugin) = held_by(&main, &entry);
                out.held.push(NameHeld {
                    name: name.clone(),
                    path: path.to_string_lossy().into_owned(),
                    by,
                    plugin,
                    agents,
                });
            }
        }
    }
    out
}

/// The Experts pack's links (and unchanged copies) of `names` that `agent`
/// — or another agent reading its link directory — has.
pub(crate) fn experts_linked(
    ctx: &SkillsCtx,
    agent: AgentType,
    names: &[String],
) -> Vec<ExpertLink> {
    conflicts(ctx, None, agent, names).takeover
}

fn is_experts(world: &World<'_>, name: &str) -> bool {
    world.provenance.origin_of(&world.ctx.store, name) == Some(SkillOrigin::Experts)
}

/// `entry` as a takeover candidate: the Experts pack's own live link to its
/// skill `name`, or its copy as made.
fn expert_link(
    world: &World<'_>,
    name: &str,
    path: &Path,
    entry: &Entry,
    agents: &[AgentType],
) -> Option<ExpertLink> {
    if path.file_name().and_then(|n| n.to_str()) != Some(name) || !is_experts(world, name) {
        return None;
    }
    let copy = match entry {
        Entry::CodegLink {
            skill,
            broken: false,
            ..
        } if skill == name => false,
        Entry::CodegCopy {
            skill,
            matches: true,
            ..
        } if skill == name => true,
        _ => return None,
    };
    Some(ExpertLink {
        name: name.to_string(),
        path: path.to_string_lossy().into_owned(),
        copy,
        agents: agents.to_vec(),
    })
}

fn held_by(world: &World<'_>, entry: &Entry) -> (HeldBy, Option<String>) {
    let origin = |skill: &str| world.provenance.origin_of(&world.ctx.store, skill);
    match entry {
        Entry::Owned { plugin, .. } => (HeldBy::Plugin, Some(plugin.clone())),
        Entry::CodegLink {
            skill,
            broken: false,
            ..
        }
        | Entry::CodegCopy { skill, .. } => match origin(skill) {
            Some(SkillOrigin::Harness) => (HeldBy::Harness, None),
            Some(SkillOrigin::Custom) | None => (HeldBy::Custom, None),
            Some(_) => (HeldBy::Pack, None),
        },
        _ => (HeldBy::Agent, None),
    }
}

// ─── Taking the Experts pack's links out, and giving them back ─────────

/// What [`unlink_experts`] or [`relink_experts`] did, link by link.
#[derive(Debug, Clone, Default)]
pub struct ExpertsChange {
    /// Done now.
    pub done: Vec<ExpertLink>,
    /// Already so (unlinked: nothing there; relinked: the pack's link is
    /// back): nothing to do.
    pub already: Vec<ExpertLink>,
    /// Not the pack's link as it was (unlink), or not free to put it back
    /// (relink): left exactly as it is.
    pub changed: Vec<ExpertLink>,
    /// Why the writes failed (then nothing of `done` stayed done).
    pub issues: Vec<SkillsIssue>,
    /// Every agent whose directories changed.
    pub touched: Vec<AgentType>,
}

impl ExpertsChange {
    pub fn ok(&self) -> bool {
        self.issues.is_empty()
    }
}

fn run(world: &mut World<'_>, plan: Plan, out: &mut ExpertsChange, done: Vec<ExpertLink>) {
    if plan.steps.is_empty() {
        return;
    }
    let report = execute(world, &[(0, &plan)]);
    out.touched = Changed {
        dirs: report.changed_dirs.clone(),
    }
    .agents(world.ctx);
    if let Some((_, issue)) = report.failed {
        out.issues.push(issue);
        out.issues
            .extend(report.rollback_issues.into_iter().map(|(_, issue)| issue));
        return;
    }
    out.done = done;
}

/// The entry `link` names, in one of the agents' directories, under its own
/// name — or `None` (then it is never touched).
fn located(ctx: &SkillsCtx, link: &ExpertLink) -> Option<(PathBuf, PathBuf)> {
    let (path, info) = locate_in_agent_dir(ctx, Path::new(&link.path))?;
    (path.file_name().and_then(|n| n.to_str()) == Some(link.name.as_str()))
        .then(|| (path, info.path.clone()))
}

/// Take the Experts pack's links in `links` out (as [`experts_linked`]
/// found them): each only while it is still the pack's own link (or its
/// copy as made) under its name; one that is gone already is `already`,
/// anything else `changed` and left alone. All or nothing. Caller holds the
/// skills lock (`ctx` is Codeg's store).
pub(crate) fn unlink_experts(
    ctx: &SkillsCtx,
    _held: &SkillsGuard,
    links: &[ExpertLink],
) -> ExpertsChange {
    let mut world = World::load(ctx);
    let mut out = ExpertsChange::default();
    let mut plan = Plan::default();
    let mut planned = Vec::new();
    for link in links {
        let Some((path, _)) = located(ctx, link) else {
            out.changed.push(link.clone());
            continue;
        };
        let entry = world.entry(&path);
        if entry.is_absent() {
            out.already.push(link.clone());
            continue;
        }
        match expert_link(&world, &link.name, &path, &entry, &[]) {
            Some(found) if found.copy => {
                plan.steps.push(Step::RemoveCopy {
                    path: path.clone(),
                    skill: link.name.clone(),
                });
                plan.removes.push(PathChange {
                    path: link.path.clone(),
                    kind: ChangeKind::Copy,
                });
            }
            Some(_) => {
                plan.steps.push(Step::RemoveLink {
                    path: path.clone(),
                    target: entry.target().map(Path::to_path_buf),
                });
                plan.removes.push(PathChange {
                    path: link.path.clone(),
                    kind: ChangeKind::Link,
                });
            }
            None => {
                out.changed.push(link.clone());
                continue;
            }
        }
        planned.push(link.clone());
    }
    run(&mut world, plan, &mut out, planned);
    out
}

/// Whether `link` was not given back only because of `plugin` itself: its
/// place holds `plugin`'s own member, or it is free and someone who reads
/// that directory still sees `plugin`'s own member of the name (an agent
/// of it not taken out yet).
/// A link whose place the user filled, or whose skill they turned on some
/// other way, is not.
pub(crate) fn held_back_by(ctx: &SkillsCtx, link: &ExpertLink, plugin: &str) -> bool {
    let Some((path, dir)) = located(ctx, link) else {
        return false;
    };
    let world = World::load(ctx);
    let entry = world.entry(&path);
    // The plugin's own member in its very place (another agent of it put
    // it there): it goes back once that agent is done.
    // …or a place that cannot be read now: nothing is known of it, so it
    // stays to be tried again.
    if entry.plugin() == Some(plugin) || matches!(entry, Entry::Unreadable(_)) {
        return true;
    }
    if !entry.is_absent() {
        return false;
    }
    let readers = ctx
        .dir_info(&dir)
        .map(|info| info.readers.clone())
        .unwrap_or_default();
    let others_see = readers
        .iter()
        .any(|reader| world.visible(*reader, &link.name).is_some());
    !others_see
        && readers.iter().any(|reader| {
            world
                .entries_of(*reader, &link.name)
                .iter()
                .any(|(_, _, _, entry)| entry.plugin() == Some(plugin))
        })
}

/// Put the Experts pack's links in `links` back, where they were: each only
/// where nothing is now and nobody who reads that directory sees the pack's
/// skill some other way (the user turned it on again meanwhile); one whose
/// place holds the pack's link already is `already`, anything else
/// `changed` and left alone. A link that cannot be made is a copy where
/// copies may stand in, as for any skill. All or nothing. The plugin's own
/// links go first (its removal). Caller holds the skills lock (`ctx` is
/// Codeg's store).
pub(crate) fn relink_experts(
    ctx: &SkillsCtx,
    _held: &SkillsGuard,
    links: &[ExpertLink],
) -> ExpertsChange {
    let mut world = World::load(ctx);
    let mut out = ExpertsChange::default();
    let mut plan = Plan::default();
    let mut planned = Vec::new();
    let mut placed: BTreeSet<PathBuf> = BTreeSet::new();
    for link in links {
        let Some((path, dir)) = located(ctx, link) else {
            out.changed.push(link.clone());
            continue;
        };
        let entry = world.entry(&path);
        if entry.is_codeg_of(&link.name) && is_experts(&world, &link.name) {
            out.already.push(link.clone());
            continue;
        }
        let readers = ctx
            .dir_info(&dir)
            .map(|info| info.readers.clone())
            .unwrap_or_default();
        let free = entry.is_absent()
            && is_experts(&world, &link.name)
            && ctx.skill_path(&link.name).is_dir()
            && readers.iter().all(|reader| {
                // Nobody who reads it sees the pack's skill some other way,
                // or a plugin's skill of the name: never two providers.
                world.visible(*reader, &link.name).is_none()
                    && !world
                        .entries_of(*reader, &link.name)
                        .iter()
                        .any(|(_, _, _, entry)| entry.plugin().is_some())
            })
            && placed.insert(entry_key(&path));
        if !free {
            out.changed.push(link.clone());
            continue;
        }
        plan.steps.push(Step::CreateLink {
            path: path.clone(),
            dir,
            skill: link.name.clone(),
        });
        plan.creates.push(PathChange {
            path: link.path.clone(),
            kind: ChangeKind::Link,
        });
        planned.push(link.clone());
    }
    run(&mut world, plan, &mut out, planned);
    out
}
