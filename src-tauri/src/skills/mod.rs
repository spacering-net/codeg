//! The skills engine: the one way Codeg puts skills from its store
//! (`~/.codeg/skills/<id>/`) into agents' skill directories, takes them out,
//! and tells what is there.
//!
//! Every skill feature goes through it — the Experts, Science, Office, UI and
//! Custom packs (`commands::{experts, science, office_tools, generative_ui,
//! custom_skills}`), the Skills page's writes (`commands::acp`), and later the
//! Harness install. What it owns:
//!
//! - **Status by directory** ([`world`]): an agent's state for a skill is
//!   decided by every global skill directory it reads, not only its first.
//! - **Shared directories**: a directory several agents read (`~/.agents/skills`,
//!   a custom agent's declared one) is worked out from `skill_storage_spec`.
//!   Enabling links into the agent's own directory when it has one; anything
//!   that changes what another agent sees needs the preflight's `ack`
//!   ([`apply`]).
//! - **Copies** ([`copies`]): where no link can be made (a Windows junction
//!   that fails), a copy through staging, recorded with its hash, refreshed
//!   only while unchanged.
//! - **The link record** ([`record`]), **provenance** ([`provenance`]),
//!   **one lock** ([`lock`]), **atomic writes** ([`fsio`]), **backups**
//!   ([`backups`]), **moving an agent's skill into Codeg** ([`adopt`]), the
//!   bundled packs' installer ([`packs`]) and what runs at startup
//!   ([`startup`]).
//! - The commands ([`commands`]) and the older packs' commands' view of it
//!   ([`legacy`]).
//! - **Plugin-owned skills** ([`owned`]): a Harness plugin installed as its
//!   skills only keeps them in a store of its own,
//!   `~/.codeg/skills/.plugins/<install name>/<skill>/` — the same engine
//!   over another store ([`SkillsCtx::owned_by`]), so the link in an agent's
//!   directory keeps the skill's own name while nothing in Codeg's store (a
//!   pack's skill of that name, say) is touched. Everywhere else such a link
//!   or copy reads as the plugin's, and nothing but the plugin's owner token
//!   changes it.
//!
//! Everything that changes something announces [`model::SKILLS_CHANGED_EVENT`].

pub(crate) mod adopt;
pub(crate) mod apply;
pub(crate) mod backups;
pub mod commands;
pub(crate) mod copies;
pub(crate) mod fsio;
pub(crate) mod legacy;
pub mod link;
pub(crate) mod lock;
pub mod model;
// The plugin side (step 8 on) is what calls most of it.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) mod owned;
pub(crate) mod packs;
pub(crate) mod provenance;
pub(crate) mod record;
pub mod startup;
pub(crate) mod world;

#[cfg(test)]
pub(crate) mod tests;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use crate::app_error::AppCommandError;
use crate::models::agent::AgentType;
use crate::web::event_bridge::{emit_event, EventEmitter};

use link::{LinkStrategy, PlatformLinks};
use model::{ChangedKind, DirRole, SkillsChanged, SKILLS_CHANGED_EVENT};

pub use model::{SkillsApplyRequest, SkillsApplyResult, SkillsInventory};

/// One agent's global skill directories, in the order it reads them.
#[derive(Debug, Clone)]
pub struct AgentDirs {
    pub agent: AgentType,
    pub dirs: Vec<PathBuf>,
    /// Those of `dirs` that hold the agent CLI's own bundled skills.
    pub read_only: Vec<PathBuf>,
    /// The agent also reads flat `<id>.md` files.
    pub markdown_files: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct DirInfo {
    /// As declared (the first agent's spelling).
    pub path: PathBuf,
    /// Normalized: what makes two spellings one directory.
    pub key: PathBuf,
    pub readers: Vec<AgentType>,
    pub read_only_for: Vec<AgentType>,
}

/// Injected failures, for the tests of what a failed step leaves behind.
#[derive(Clone, Default)]
pub(crate) struct Faults {
    #[cfg(test)]
    armed: Arc<std::sync::Mutex<std::collections::BTreeSet<&'static str>>>,
}

/// Where everything is: the store, the lock, every agent's directories, and
/// how links are made. [`SkillsCtx::user`] is the real one, resolved anew on
/// each call (agents' environments and custom agents change); tests build
/// their own over temporary directories.
#[derive(Clone)]
pub struct SkillsCtx {
    pub store: PathBuf,
    pub lock_path: PathBuf,
    pub lock_wait: Duration,
    pub agents: Vec<AgentDirs>,
    pub linker: Arc<dyn LinkStrategy>,
    /// The plugin whose own store `store` is ([`Self::owned_by`]); `None`
    /// for Codeg's store.
    pub(crate) owner: Option<String>,
    /// `<Codeg's store>/.plugins`: every plugin's own store, one folder per
    /// install name.
    pub(crate) plugins_root: PathBuf,
    dirs: Vec<DirInfo>,
    agent_dirs: BTreeMap<AgentType, Vec<usize>>,
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) faults: Faults,
}

impl std::fmt::Debug for SkillsCtx {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SkillsCtx")
            .field("store", &self.store)
            .field("lock_path", &self.lock_path)
            .field("agents", &self.agents)
            .finish_non_exhaustive()
    }
}

impl SkillsCtx {
    pub fn new(
        store: PathBuf,
        lock_path: PathBuf,
        agents: Vec<AgentDirs>,
        linker: Arc<dyn LinkStrategy>,
    ) -> Self {
        let mut dirs: Vec<DirInfo> = Vec::new();
        let mut agent_dirs: BTreeMap<AgentType, Vec<usize>> = BTreeMap::new();
        for agent in &agents {
            let read_only_keys: Vec<PathBuf> =
                agent.read_only.iter().map(|d| fsio::normalize(d)).collect();
            let mut mine: Vec<usize> = Vec::new();
            for dir in &agent.dirs {
                let key = fsio::normalize(dir);
                let index = match dirs.iter().position(|d| fsio::same_path(&d.key, &key)) {
                    Some(index) => index,
                    None => {
                        dirs.push(DirInfo {
                            path: dir.clone(),
                            key: key.clone(),
                            readers: Vec::new(),
                            read_only_for: Vec::new(),
                        });
                        dirs.len() - 1
                    }
                };
                if mine.contains(&index) {
                    continue;
                }
                mine.push(index);
                let info = &mut dirs[index];
                if !info.readers.contains(&agent.agent) {
                    info.readers.push(agent.agent);
                }
                if read_only_keys.iter().any(|k| fsio::same_path(k, &key))
                    && !info.read_only_for.contains(&agent.agent)
                {
                    info.read_only_for.push(agent.agent);
                }
            }
            agent_dirs.insert(agent.agent, mine);
        }
        Self {
            plugins_root: store.join(owned::PLUGINS_DIR),
            owner: None,
            store,
            lock_path,
            lock_wait: lock::LOCK_WAIT,
            agents,
            linker,
            dirs,
            agent_dirs,
            faults: Faults::default(),
        }
    }

    /// The real store, lock and agents, from the environment Codeg runs in.
    pub fn user() -> Self {
        use crate::commands::acp::{is_read_only_skill_path, skill_storage_spec, SkillStorageKind};
        let agents = crate::acp::registry::all_acp_agents()
            .into_iter()
            .filter_map(|agent| {
                let spec = skill_storage_spec(agent)?;
                let read_only = spec
                    .global_dirs
                    .iter()
                    .filter(|dir| is_read_only_skill_path(agent, dir))
                    .cloned()
                    .collect();
                Some(AgentDirs {
                    agent,
                    dirs: spec.global_dirs,
                    read_only,
                    markdown_files: spec.kind == SkillStorageKind::SkillDirectoryOrMarkdownFile,
                })
            })
            .collect();
        Self::new(
            crate::commands::experts::central_experts_dir(),
            lock::default_lock_path(),
            agents,
            Arc::new(PlatformLinks),
        )
    }

    pub(crate) fn agent(&self, agent: AgentType) -> Option<&AgentDirs> {
        self.agents.iter().find(|a| a.agent == agent)
    }

    /// The agent's directories (each once), with what each is to it.
    pub(crate) fn dirs_of(&self, agent: AgentType) -> Vec<(&DirInfo, DirRole)> {
        self.agent_dirs
            .get(&agent)
            .map(|indices| {
                indices
                    .iter()
                    .map(|&i| {
                        let info = &self.dirs[i];
                        (info, self.role_in(info, agent))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn role_in(&self, info: &DirInfo, agent: AgentType) -> DirRole {
        if info.read_only_for.contains(&agent) {
            DirRole::ReadOnly
        } else if info.readers.len() > 1 {
            DirRole::Shared
        } else {
            DirRole::Own
        }
    }

    /// Every distinct directory, as declared.
    pub(crate) fn all_dirs(&self) -> Vec<PathBuf> {
        self.dirs.iter().map(|d| d.path.clone()).collect()
    }

    /// The directory `dir` is (any spelling), when an agent reads it.
    pub(crate) fn dir_info(&self, dir: &Path) -> Option<&DirInfo> {
        let key = fsio::normalize(dir);
        self.dirs.iter().find(|d| fsio::same_path(&d.key, &key))
    }

    /// Who reads the directory an entry is in.
    pub(crate) fn readers_of_entry(&self, entry: &Path) -> Vec<AgentType> {
        entry
            .parent()
            .and_then(|dir| self.dir_info(dir))
            .map(|info| info.readers.clone())
            .unwrap_or_default()
    }

    /// Where enabling puts the link: the agent's first directory of its own,
    /// else its first shared one. With whether it is shared.
    pub(crate) fn link_dir(&self, agent: AgentType) -> Option<(PathBuf, bool)> {
        let dirs = self.dirs_of(agent);
        dirs.iter()
            .find(|(_, role)| *role == DirRole::Own)
            .map(|(info, _)| (info.path.clone(), false))
            .or_else(|| {
                dirs.iter()
                    .find(|(_, role)| *role == DirRole::Shared)
                    .map(|(info, _)| (info.path.clone(), true))
            })
    }

    /// The agent's first directory of its own.
    pub(crate) fn own_dir(&self, agent: AgentType) -> Option<PathBuf> {
        self.dirs_of(agent)
            .into_iter()
            .find(|(_, role)| *role == DirRole::Own)
            .map(|(info, _)| info.path.clone())
    }

    pub(crate) fn skill_path(&self, id: &str) -> PathBuf {
        self.store.join(id)
    }

    /// Codeg's own store: `store` itself, or — for a plugin's own store —
    /// the one its `.plugins` is in. Backups of skills always go there.
    pub(crate) fn main_store(&self) -> PathBuf {
        match &self.owner {
            Some(_) => self
                .plugins_root
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| self.store.clone()),
            None => self.store.clone(),
        }
    }

    /// The same agents, lock and links over the plugin `plugin`'s own store
    /// (no check of the name: [`Self::owned_by`] is the way in).
    pub(crate) fn over_plugin_store(&self, plugin: &str) -> SkillsCtx {
        let mut ctx = self.clone();
        ctx.store = self.plugins_root.join(plugin);
        ctx.owner = Some(plugin.to_string());
        ctx
    }

    /// Fail at `point` when a test armed it.
    pub(crate) fn fault(&self, point: &'static str) -> std::io::Result<()> {
        #[cfg(test)]
        {
            let armed = self.faults.armed.lock().unwrap_or_else(|e| e.into_inner());
            if armed.contains(point) {
                return Err(std::io::Error::other(format!(
                    "injected failure at {point}"
                )));
            }
        }
        let _ = point;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn arm_fault(&self, point: &'static str) {
        self.faults
            .armed
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(point);
    }

    #[cfg(test)]
    pub(crate) fn disarm_faults(&self) {
        self.faults
            .armed
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }

    pub(crate) async fn lock(&self) -> Result<lock::SkillsGuard, lock::SkillsLockError> {
        lock::acquire_at(&self.lock_path, self.lock_wait).await
    }

    pub(crate) fn lock_blocking(&self) -> Result<lock::SkillsGuard, lock::SkillsLockError> {
        lock::acquire_blocking_at(&self.lock_path, self.lock_wait)
    }
}

/// The store, as written and as resolved: what tells a link into it.
#[derive(Debug, Clone)]
pub(crate) struct StorePaths {
    raw: PathBuf,
    canonical: Option<PathBuf>,
}

impl StorePaths {
    pub fn of(store: &Path) -> Self {
        Self {
            raw: fsio::lexical(store),
            canonical: std::fs::canonicalize(store).ok(),
        }
    }

    /// The store id `path` names when it is a direct child of the store.
    pub fn child_of(&self, path: &Path) -> Option<String> {
        let parent = path.parent()?;
        let parent = fsio::lexical(parent);
        let inside = fsio::same_path(&parent, &self.raw)
            || self
                .canonical
                .as_deref()
                .is_some_and(|canonical| fsio::same_path(&parent, canonical));
        if !inside {
            return None;
        }
        let name = path.file_name()?.to_string_lossy().into_owned();
        (!name.starts_with('.')).then_some(name)
    }
}

/// Tell every window and web client what changed, and for which agents.
pub(crate) fn announce(
    emitter: &EventEmitter,
    kinds: impl IntoIterator<Item = ChangedKind>,
    agents: impl IntoIterator<Item = AgentType>,
) {
    let mut kinds: Vec<ChangedKind> = kinds.into_iter().collect();
    kinds.sort();
    kinds.dedup();
    if kinds.is_empty() {
        return;
    }
    let mut agents: Vec<AgentType> = agents.into_iter().collect();
    agents.sort();
    agents.dedup();
    emit_event(
        emitter,
        SKILLS_CHANGED_EVENT,
        SkillsChanged { kinds, agents },
    );
}

/// An error stamped with its stable code, the MCP engine's way:
/// `i18n_key = "errors.<codeInCamelCase>"`, `i18n_params.code` = the code.
pub(crate) fn coded_error(
    error: AppCommandError,
    code: &str,
    detail: Option<String>,
) -> AppCommandError {
    crate::commands::mcp_engine::coded_error(error, code, detail)
}

/// The store directory of this user (`~/.codeg/skills`).
pub fn store_dir() -> PathBuf {
    crate::commands::experts::central_experts_dir()
}
