//! What is where: every entry under a skill's name in every directory an
//! agent reads, told apart by whose it is — and, for planning, the same view
//! with changes laid over it that are not on disk yet.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use crate::acp::types::{AgentSkillItem, AgentSkillOwner};
use crate::models::agent::AgentType;

use super::fsio::{entry_key, hash_skill_dir};
use super::link::{inspect, LinkMode, RawEntry};
use super::model::{
    AgentSkillDir, BrokenLink, CellEntry, CellState, DirRole, EntryKind, NameTaken, SkillCell,
    SkillOrigin, SkillsAgent, SkillsInventory, StoreSkill,
};
use super::provenance::{store_skills, Provenance, UI_IDS};
use super::record::LinkRecord;
use super::{SkillsCtx, StorePaths};

/// One entry, as far as skills go.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Entry {
    Absent,
    /// A link into the store, to `skill` — or a broken one that pointed
    /// there (or that the record says Codeg made).
    CodegLink {
        skill: String,
        target: Option<PathBuf>,
        broken: bool,
    },
    /// A real folder the record says Codeg copied `skill` into.
    CodegCopy {
        skill: String,
        /// The copy is what was copied (its recorded hash).
        matches: bool,
        /// The copy equals the skill in the store now.
        current: bool,
    },
    ForeignLink {
        target: Option<PathBuf>,
        broken: bool,
    },
    Folder,
    File,
    Unreadable(String),
}

impl Entry {
    pub fn is_absent(&self) -> bool {
        matches!(self, Entry::Absent)
    }

    /// Codeg's live link or copy of `skill`.
    pub fn is_codeg_of(&self, skill: &str) -> bool {
        match self {
            Entry::CodegLink {
                skill: s,
                broken: false,
                ..
            } => s == skill,
            Entry::CodegCopy { skill: s, .. } => s == skill,
            _ => false,
        }
    }

    pub fn target(&self) -> Option<&Path> {
        match self {
            Entry::CodegLink { target, .. } | Entry::ForeignLink { target, .. } => {
                target.as_deref()
            }
            _ => None,
        }
    }

    /// As seen for the skill `skill`: a link to another skill in the store is
    /// a link to somewhere else.
    pub fn kind_for(&self, skill: &str) -> EntryKind {
        match self {
            Entry::Absent => EntryKind::File,
            Entry::CodegLink {
                skill: s,
                broken: false,
                ..
            } if s == skill => EntryKind::CodegLink,
            Entry::CodegLink { broken: false, .. } => EntryKind::Link,
            Entry::CodegLink { broken: true, .. } => EntryKind::CodegBroken,
            Entry::CodegCopy { skill: s, .. } if s == skill => EntryKind::CodegCopy,
            Entry::CodegCopy { .. } => EntryKind::Folder,
            Entry::ForeignLink { broken: false, .. } => EntryKind::Link,
            Entry::ForeignLink { broken: true, .. } => EntryKind::BrokenLink,
            Entry::Folder => EntryKind::Folder,
            Entry::File => EntryKind::File,
            Entry::Unreadable(_) => EntryKind::Unreadable,
        }
    }
}

/// Codeg's live entry of a skill that an agent sees.
#[derive(Debug, Clone)]
pub(crate) struct Visible {
    pub path: PathBuf,
}

pub(crate) struct World<'c> {
    pub ctx: &'c SkillsCtx,
    pub store: StorePaths,
    pub record: LinkRecord,
    pub provenance: Provenance,
    overlay: BTreeMap<PathBuf, Entry>,
    cache: RefCell<BTreeMap<PathBuf, Entry>>,
    store_hashes: RefCell<BTreeMap<String, Option<String>>>,
    /// Store ids planned as if they were in the store already (a Harness
    /// install's preflight, before its folder is there): `enable` plans for
    /// them, and a link of Codeg's to one reads as live, as it will once the
    /// folder is in. Empty for every other view.
    pending: BTreeSet<String>,
}

impl<'c> World<'c> {
    pub fn load(ctx: &'c SkillsCtx) -> Self {
        Self::load_pending(ctx, BTreeSet::new())
    }

    /// [`Self::load`], with `pending` taken to be in the store.
    pub fn load_pending(ctx: &'c SkillsCtx, pending: BTreeSet<String>) -> Self {
        Self {
            ctx,
            store: StorePaths::of(&ctx.store),
            record: LinkRecord::load(&ctx.store),
            provenance: Provenance::load(&ctx.store),
            overlay: BTreeMap::new(),
            cache: RefCell::new(BTreeMap::new()),
            store_hashes: RefCell::new(BTreeMap::new()),
            pending,
        }
    }

    /// Whether the store has `skill` (or it is planned as there).
    pub fn store_has(&self, skill: &str) -> bool {
        self.pending.contains(skill) || self.ctx.skill_path(skill).is_dir()
    }

    /// Forget what was read: the disk changed under this view.
    pub fn refresh(&mut self) {
        self.cache.borrow_mut().clear();
        self.store_hashes.borrow_mut().clear();
        self.overlay.clear();
    }

    /// The hash of the store's copy of `skill` (cached).
    pub fn store_hash(&self, skill: &str) -> Option<String> {
        if let Some(hash) = self.store_hashes.borrow().get(skill) {
            return hash.clone();
        }
        let dir = self.ctx.skill_path(skill);
        let hash = dir
            .is_dir()
            .then(|| hash_skill_dir(&dir, skill).ok())
            .flatten();
        self.store_hashes
            .borrow_mut()
            .insert(skill.to_string(), hash.clone());
        hash
    }

    fn classify(&self, path: &Path) -> Entry {
        match inspect(path) {
            RawEntry::Absent => Entry::Absent,
            RawEntry::Unreadable(err) => Entry::Unreadable(err),
            RawEntry::File => Entry::File,
            RawEntry::Dir => match self.record.get(path) {
                Some(rec) if rec.mode == LinkMode::Copy => {
                    let hash = hash_skill_dir(path, &rec.skill).ok();
                    let matches = hash.is_some() && hash == rec.copy_hash;
                    let current = hash.is_some() && hash == self.store_hash(&rec.skill);
                    Entry::CodegCopy {
                        skill: rec.skill.clone(),
                        matches,
                        current,
                    }
                }
                _ => Entry::Folder,
            },
            RawEntry::Link { target, resolved } => {
                if let Some(skill) = target.as_deref().and_then(|t| self.store.child_of(t)) {
                    return Entry::CodegLink {
                        broken: resolved.is_none() && !self.pending.contains(&skill),
                        skill,
                        target,
                    };
                }
                match resolved {
                    Some(real) => match self.store.child_of(&real) {
                        Some(skill) => Entry::CodegLink {
                            skill,
                            target,
                            broken: false,
                        },
                        None => Entry::ForeignLink {
                            target,
                            broken: false,
                        },
                    },
                    None => match self
                        .record
                        .get(path)
                        .filter(|rec| rec.mode != LinkMode::Copy)
                    {
                        Some(rec) => Entry::CodegLink {
                            skill: rec.skill.clone(),
                            target,
                            broken: true,
                        },
                        None => Entry::ForeignLink {
                            target,
                            broken: true,
                        },
                    },
                }
            }
        }
    }

    /// What is at `path`, planned changes included.
    pub fn entry(&self, path: &Path) -> Entry {
        let key = entry_key(path);
        if let Some(entry) = self.overlay.get(&key) {
            return entry.clone();
        }
        if let Some(entry) = self.cache.borrow().get(&key) {
            return entry.clone();
        }
        let entry = self.classify(path);
        self.cache.borrow_mut().insert(key, entry.clone());
        entry
    }

    /// Lay a planned change over the view.
    pub fn set(&mut self, path: &Path, entry: Entry) {
        self.overlay.insert(entry_key(path), entry);
    }

    /// Where the agent sees Codeg's `skill`, in its reading order.
    pub fn visible(&self, agent: AgentType, skill: &str) -> Option<Visible> {
        for (info, _) in self.ctx.dirs_of(agent) {
            let path = info.path.join(skill);
            if self.entry(&path).is_codeg_of(skill) {
                return Some(Visible { path });
            }
        }
        None
    }

    /// Every agent that sees Codeg's `skill`.
    pub fn seen_by(&self, skill: &str) -> Vec<AgentType> {
        self.ctx
            .agents
            .iter()
            .filter(|a| self.visible(a.agent, skill).is_some())
            .map(|a| a.agent)
            .collect()
    }

    /// Everything under `skill`'s name in the agent's directories.
    pub fn entries_of(
        &self,
        agent: AgentType,
        skill: &str,
    ) -> Vec<(PathBuf, PathBuf, DirRole, Entry)> {
        let markdown = self
            .ctx
            .agent(agent)
            .map(|a| a.markdown_files)
            .unwrap_or(false);
        let mut out = Vec::new();
        for (info, role) in self.ctx.dirs_of(agent) {
            let path = info.path.join(skill);
            let entry = self.entry(&path);
            if !entry.is_absent() {
                out.push((path, info.path.clone(), role, entry));
                continue;
            }
            if markdown {
                let flat = info.path.join(format!("{skill}.md"));
                let entry = self.entry(&flat);
                if !entry.is_absent() {
                    out.push((flat, info.path.clone(), role, entry));
                }
            }
        }
        out
    }

    pub fn cell(&self, agent: AgentType, skill: &str) -> SkillCell {
        let found = self.entries_of(agent, skill);
        let entries: Vec<CellEntry> = found
            .iter()
            .map(|(path, dir, role, entry)| {
                let (copy_matches, copy_current) = match entry {
                    Entry::CodegCopy {
                        matches, current, ..
                    } => (Some(*matches), Some(*current)),
                    _ => (None, None),
                };
                CellEntry {
                    path: path.to_string_lossy().into_owned(),
                    dir: dir.to_string_lossy().into_owned(),
                    dir_role: *role,
                    kind: entry.kind_for(skill),
                    target: entry.target().map(|t| t.to_string_lossy().into_owned()),
                    copy_matches,
                    copy_current,
                }
            })
            .collect();
        let deciding = found
            .iter()
            .find(|(_, _, _, entry)| entry.is_codeg_of(skill))
            .or_else(|| found.first());
        let Some((path, dir, role, entry)) = deciding else {
            return SkillCell {
                agent,
                state: CellState::NotLinked,
                path: None,
                dir: None,
                dir_role: None,
                target: None,
                codeg: false,
                copy_matches: None,
                copy_current: None,
                shared_with: Vec::new(),
                entries,
            };
        };
        let state = match entry {
            Entry::CodegLink {
                skill: s,
                broken: false,
                ..
            } if s == skill => {
                if *role == DirRole::Shared {
                    CellState::VisibleThrough
                } else {
                    CellState::Linked
                }
            }
            Entry::CodegCopy { skill: s, .. } if s == skill => CellState::Copy,
            Entry::CodegLink { broken: true, .. } | Entry::ForeignLink { broken: true, .. } => {
                CellState::Broken
            }
            Entry::CodegLink { .. } | Entry::ForeignLink { .. } => CellState::LinkedElsewhere,
            Entry::CodegCopy { .. } | Entry::Folder | Entry::File | Entry::Unreadable(_) => {
                CellState::Blocked
            }
            Entry::Absent => CellState::NotLinked,
        };
        let codeg = match entry {
            Entry::CodegLink { skill: s, .. } => s == skill,
            Entry::CodegCopy { skill: s, .. } => s == skill,
            _ => false,
        };
        let (copy_matches, copy_current) = match entry {
            Entry::CodegCopy {
                matches, current, ..
            } => (Some(*matches), Some(*current)),
            _ => (None, None),
        };
        let shared_with = if *role == DirRole::Shared {
            self.ctx
                .dir_info(dir)
                .map(|info| {
                    info.readers
                        .iter()
                        .copied()
                        .filter(|a| *a != agent)
                        .collect()
                })
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        SkillCell {
            agent,
            state,
            path: Some(path.to_string_lossy().into_owned()),
            dir: Some(dir.to_string_lossy().into_owned()),
            dir_role: Some(*role),
            target: entry.target().map(|t| t.to_string_lossy().into_owned()),
            codeg,
            copy_matches,
            copy_current,
            shared_with,
            entries,
        }
    }

    /// Every broken link Codeg made, in every directory.
    pub fn broken_links(&self) -> Vec<BrokenLink> {
        let mut out = Vec::new();
        for info in &self.ctx.dirs {
            for name in super::fsio::child_names(&info.path) {
                let path = info.path.join(&name);
                if let Entry::CodegLink {
                    skill,
                    target,
                    broken: true,
                } = self.entry(&path)
                {
                    out.push(BrokenLink {
                        path: path.to_string_lossy().into_owned(),
                        dir: info.path.to_string_lossy().into_owned(),
                        target: target.map(|t| t.to_string_lossy().into_owned()),
                        skill,
                        agents: info.readers.clone(),
                    });
                }
            }
        }
        out
    }
}

/// The bundled ids of each pack, for "name taken".
pub(crate) fn bundled_pack_ids() -> Vec<(SkillOrigin, Vec<String>)> {
    vec![
        (
            SkillOrigin::Experts,
            crate::commands::experts::bundled_ids(),
        ),
        (
            SkillOrigin::Science,
            crate::commands::science::bundled_ids(),
        ),
        (
            SkillOrigin::Office,
            crate::commands::office_tools::bundled_skill_ids(),
        ),
        (SkillOrigin::Ui, vec![UI_IDS[0].to_string()]),
    ]
}

/// A pack's ids that a skill of another origin holds in the store.
pub(crate) fn name_taken(ctx: &SkillsCtx, provenance: &Provenance) -> Vec<NameTaken> {
    let mut out = Vec::new();
    for (pack, ids) in bundled_pack_ids() {
        for id in ids {
            if !ctx.skill_path(&id).exists() {
                continue;
            }
            let held_by = provenance
                .origin_of(&ctx.store, &id)
                .unwrap_or(SkillOrigin::Custom);
            if held_by != pack {
                out.push(NameTaken { id, pack, held_by });
            }
        }
    }
    out
}

pub(crate) fn agents_view(ctx: &SkillsCtx) -> Vec<SkillsAgent> {
    ctx.agents
        .iter()
        .map(|agent| {
            let dirs = ctx
                .dirs_of(agent.agent)
                .into_iter()
                .map(|(info, role)| AgentSkillDir {
                    path: info.path.to_string_lossy().into_owned(),
                    role,
                    shared_with: info
                        .readers
                        .iter()
                        .copied()
                        .filter(|a| *a != agent.agent)
                        .collect(),
                    exists: info.path.is_dir(),
                })
                .collect();
            let link_dir = ctx.link_dir(agent.agent);
            SkillsAgent {
                agent: agent.agent,
                dirs,
                link_dir_shared: link_dir.as_ref().is_some_and(|(_, shared)| *shared),
                link_dir: link_dir.map(|(dir, _)| dir.to_string_lossy().into_owned()),
            }
        })
        .collect()
}

pub(crate) fn inventory(ctx: &SkillsCtx) -> SkillsInventory {
    let world = World::load(ctx);
    let backups = super::backups::counts(ctx);
    let skills = store_skills(&ctx.store, &world.provenance)
        .into_iter()
        .map(|(id, origin)| {
            let dir = ctx.skill_path(&id);
            let skill_md = dir.join("SKILL.md");
            let name = crate::commands::custom_skills::read_frontmatter_name(&skill_md)
                .unwrap_or_else(|| id.clone());
            let description = crate::commands::acp::read_skill_description(&skill_md);
            let cells = ctx
                .agents
                .iter()
                .map(|a| world.cell(a.agent, &id))
                .collect();
            StoreSkill {
                pending_user_review: world.provenance.pending_user_review(&id),
                harness: (origin == SkillOrigin::Harness)
                    .then(|| world.provenance.harness_info(&id))
                    .flatten(),
                backups: backups.get(&id).copied().unwrap_or(0),
                path: dir.to_string_lossy().into_owned(),
                id,
                origin,
                name,
                description,
                cells,
            }
        })
        .collect();
    let mut problems = world.provenance.problems.clone();
    if let Some(problem) = &world.record.problem {
        problems.push(problem.clone());
    }
    SkillsInventory {
        store: ctx.store.to_string_lossy().into_owned(),
        agents: agents_view(ctx),
        skills,
        name_taken: name_taken(ctx, &world.provenance),
        broken_links: world.broken_links(),
        problems,
    }
}

/// Fill in whose each of an agent's listed skills is, and where its link
/// points (the Skills page's view).
pub(crate) fn annotate_items(store: &Path, items: &mut [AgentSkillItem]) {
    if items.is_empty() {
        return;
    }
    let paths = StorePaths::of(store);
    let record = LinkRecord::load(store);
    let provenance = Provenance::load(store);
    let owner_of = |id: &str| -> (AgentSkillOwner, Option<String>) {
        match provenance.origin_of(store, id) {
            Some(SkillOrigin::Harness) => (AgentSkillOwner::Harness, None),
            Some(origin) if origin.is_pack() => {
                (AgentSkillOwner::Pack, Some(origin.as_str().to_string()))
            }
            _ => (AgentSkillOwner::Custom, None),
        }
    };
    for item in items.iter_mut() {
        let path = PathBuf::from(&item.path);
        match inspect(&path) {
            RawEntry::Link { target, resolved } => {
                item.link_target = target.as_ref().map(|t| t.to_string_lossy().into_owned());
                let into_store = target
                    .as_deref()
                    .and_then(|t| paths.child_of(t))
                    .or_else(|| resolved.as_deref().and_then(|r| paths.child_of(r)));
                let (owner, pack) = match (into_store, resolved.is_some()) {
                    (_, false) => (AgentSkillOwner::Broken, None),
                    (Some(id), true) => owner_of(&id),
                    (None, true) => (AgentSkillOwner::LinkedElsewhere, None),
                };
                item.owner = owner;
                item.pack = pack;
            }
            RawEntry::Dir => {
                if let Some(rec) = record.get(&path).filter(|r| r.mode == LinkMode::Copy) {
                    let (owner, pack) = owner_of(&rec.skill);
                    item.owner = owner;
                    item.pack = pack;
                    item.codeg_copy = true;
                }
            }
            _ => {}
        }
    }
}
