//! Generative UI: the `ui-render` skill, and the agents it is enabled for.
//!
//! Two halves:
//!   * the chat renders a ```spec fence in an assistant reply as a json-render
//!     card — frontend only, always on;
//!   * an agent learns to write that fence from a skill Codeg ships,
//!     `ui-render` (`genui/ui-render/SKILL.md`, generated from the frontend's
//!     catalog), which the user enables per agent on the UI tab of Skill
//!     Packs — the same matrix the Experts tab uses.
//!
//! The skill reaches an agent the way the bundled skill packs do: a central
//! copy in the shared store (`~/.codeg/skills/ui-render`), symlinked (or
//! junctioned) into the agent's preferred skill directory. A cell of the
//! matrix links or unlinks at once, and what it shows is the link on disk:
//! nothing is stored anywhere else. Startup brings the central copy up to date
//! ([`install_generative_ui_skill`]), so every agent it is linked into reads
//! the bundled version. It runs before Codeg serves any command, so nothing on
//! the settings page can race it.
//!
//! **Ownership.** The central copy carries a marker file. A link is ours only
//! when it resolves to the central copy AND that copy is marked. Codeg never
//! removes its central copy, so a link of ours never dangles: a dangling link
//! cannot be attributed to anyone and is left alone. A `ui-render` directory
//! in the central store WITHOUT the marker is the user's own skill of that
//! name, possibly already linked into agents. Codeg then does nothing with
//! it — no overwrite, no link, no unlink — and the settings page asks the user
//! to rename theirs. Taking it over instead would leave the user's existing
//! links pointing at Codeg's content, and the next disable would delete them
//! as ours.
//!
//! **The old name.** Codeg 0.35.0 shipped the skill as `json-render`, linked
//! into every agent Codeg started while one switch (`generative_ui.enabled`)
//! was on. Startup moves that over ([`migrate_legacy`]): with the switch on,
//! an agent that had our `json-render` gets `ui-render` in its place; either
//! way every `json-render` link of ours goes, and so does the old central copy
//! once none is left. A choice made on the settings page for an agent takes
//! its `json-render` away at once, so the move never undoes it.

use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use sea_orm::DatabaseConnection;
use serde::Serialize;
use tokio::sync::Mutex;

use crate::acp::types::AgentSkillScope;
use crate::app_error::AppCommandError;
use crate::commands::acp::{remove_skill_entry, scoped_skill_dirs, skill_storage_spec};
use crate::commands::experts::{
    central_experts_dir, classify_link, create_link_raw, read_link_target, ExpertInstallStatus,
    ExpertLinkState, LinkOp, LinkOpResult,
};
use crate::db::service::app_metadata_service;
use crate::models::agent::AgentType;

/// The skill's directory name everywhere, and what the user types
/// (`/ui-render`, `$ui-render` in Codex).
pub(crate) const SKILL_ID: &str = "ui-render";

/// Generated from the frontend catalog (`src/lib/json-render/skill.ts`);
/// `skill.test.ts` keeps the two equal.
const SKILL_MD: &str = include_str!("../../genui/ui-render/SKILL.md");

/// Written into the central copy before anything else: says Codeg made it.
pub(crate) const MARKER_FILE: &str = ".codeg-managed";
const MARKER_TEXT: &str = "Codeg installs this skill (Settings > Skill Packs > UI) and \
rewrites it when it changes. Edits made here are lost.\n";

/// What Codeg 0.35.0 called the skill. Its central copy carries the same
/// marker, plus a list of every link made from it, one path per line.
const LEGACY_SKILL_ID: &str = "json-render";
const LEGACY_LINKS_FILE: &str = ".codeg-links";
/// The 0.35.0 switch that linked `json-render` into every agent Codeg
/// started. Read once more, to move its links over; nothing writes it now.
const LEGACY_SWITCH_KEY: &str = "generative_ui.enabled";

/// What the settings page needs besides the link states.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GenerativeUiSkillInfo {
    /// The skill's name: its directory, and what the user types.
    pub id: String,
    /// The central store holds a `ui-render` Codeg did not write, so Codeg
    /// leaves the skill alone until the user renames theirs (see the module
    /// doc).
    pub conflict: bool,
}

// ─── Where things live ──────────────────────────────────────────────────

/// Where the central copies go and where each agent looks for skills. The
/// real one resolves both on every call, from the environment Codeg runs in;
/// tests point both at temporary directories.
#[derive(Debug, Clone)]
enum SkillHome {
    User,
    #[cfg(test)]
    Fixed {
        central_root: PathBuf,
        agents: Vec<(AgentType, Vec<PathBuf>)>,
    },
}

impl SkillHome {
    fn central_root(&self) -> PathBuf {
        match self {
            SkillHome::User => central_experts_dir(),
            #[cfg(test)]
            SkillHome::Fixed { central_root, .. } => central_root.clone(),
        }
    }

    fn central_copy(&self) -> PathBuf {
        self.central_root().join(SKILL_ID)
    }

    fn legacy_copy(&self) -> PathBuf {
        self.central_root().join(LEGACY_SKILL_ID)
    }

    /// Every agent with a skill store — the matrix's columns — each with its
    /// global skill directories, the preferred one first.
    fn agents(&self) -> Vec<(AgentType, Vec<PathBuf>)> {
        match self {
            SkillHome::User => crate::acp::registry::all_acp_agents()
                .into_iter()
                .filter(|agent| skill_storage_spec(*agent).is_some())
                .map(|agent| (agent, user_agent_dirs(agent)))
                .collect(),
            #[cfg(test)]
            SkillHome::Fixed { agents, .. } => agents.clone(),
        }
    }

    /// One agent's global skill directories, the preferred one first. Empty
    /// for an agent without a skill store.
    fn agent_dirs(&self, agent: AgentType) -> Vec<PathBuf> {
        match self {
            SkillHome::User => user_agent_dirs(agent),
            #[cfg(test)]
            SkillHome::Fixed { agents, .. } => agents
                .iter()
                .find(|(a, _)| *a == agent)
                .map(|(_, dirs)| dirs.clone())
                .unwrap_or_default(),
        }
    }
}

fn user_agent_dirs(agent: AgentType) -> Vec<PathBuf> {
    scoped_skill_dirs(agent, AgentSkillScope::Global, None).unwrap_or_default()
}

/// Every skill directory of these agents, each once — several agents share
/// `~/.agents/skills`.
fn every_dir(agents: &[(AgentType, Vec<PathBuf>)]) -> Vec<PathBuf> {
    let mut seen = BTreeSet::new();
    agents
        .iter()
        .flat_map(|(_, dirs)| dirs.iter().cloned())
        .filter(|dir| seen.insert(dir.clone()))
        .collect()
}

// ─── The central copy ───────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CentralCopy {
    Absent,
    /// A real directory carrying our marker.
    Ours,
    /// Anything else under that name: the user's own skill.
    Foreign,
}

/// A directory whose marker cannot even be looked at is an error, never
/// "not ours": it may well be ours, and acting as if it were not would leave
/// our links behind.
fn central_copy_state(dir: &Path) -> io::Result<CentralCopy> {
    match fs::symlink_metadata(dir) {
        Ok(meta) if meta.is_dir() => match fs::metadata(dir.join(MARKER_FILE)) {
            Ok(marker) if marker.is_file() => Ok(CentralCopy::Ours),
            Ok(_) => Ok(CentralCopy::Foreign),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(CentralCopy::Foreign),
            Err(err) => Err(err),
        },
        Ok(_) => Ok(CentralCopy::Foreign),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(CentralCopy::Absent),
        Err(err) => Err(err),
    }
}

fn is_ours(dir: &Path) -> bool {
    matches!(central_copy_state(dir), Ok(CentralCopy::Ours))
}

fn is_foreign(dir: &Path) -> bool {
    matches!(central_copy_state(dir), Ok(CentralCopy::Foreign))
}

/// Create the central copy on first use and rewrite its `SKILL.md` whenever
/// it differs from the bundled one. Refuses to touch a copy that is not ours.
fn ensure_central_copy(dir: &Path) -> io::Result<()> {
    match central_copy_state(dir)? {
        CentralCopy::Foreign => {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!(
                    "{} is a skill of your own; rename it to use the built-in one",
                    dir.display()
                ),
            ))
        }
        CentralCopy::Absent => {
            if let Some(parent) = dir.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::create_dir(dir)?;
            // The marker before the skill: a copy cut short before its
            // SKILL.md is still recognisably ours and gets finished next
            // time, while an unmarked SKILL.md would pass for the user's own.
            fs::write(dir.join(MARKER_FILE), MARKER_TEXT)?;
        }
        CentralCopy::Ours => {}
    }
    let skill_md = dir.join("SKILL.md");
    if fs::read(&skill_md).ok().as_deref() != Some(SKILL_MD.as_bytes()) {
        // Through a rename, so an agent reading the skill never sees half.
        let partial = dir.join(".SKILL.md.partial");
        fs::write(&partial, SKILL_MD)?;
        if let Err(err) = fs::rename(&partial, &skill_md) {
            let _ = fs::remove_file(&partial);
            return Err(err);
        }
    }
    Ok(())
}

// ─── Links ──────────────────────────────────────────────────────────────

/// Link the central copy into `dir`, an agent's preferred skill directory.
/// Whatever already holds the skill's name there stays, and says so.
fn link_into(central: &Path, dir: &Path) -> io::Result<()> {
    let link = dir.join(SKILL_ID);
    // Decided before creating anything, never by trying and reading the
    // error: on Windows `create_link_raw` falls back to copying the whole
    // directory when it cannot make a junction, which would write over a
    // directory of the same name.
    let taken = |what: &str| {
        io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!(
                "{what} already exists at {} — remove or rename it first",
                link.display()
            ),
        )
    };
    match classify_link(&link, central) {
        ExpertLinkState::NotLinked => {
            fs::create_dir_all(dir)?;
            create_link_raw(central, &link)?;
            tracing::info!("[GenerativeUI] linked {}", link.display());
            Ok(())
        }
        ExpertLinkState::LinkedToCodeg => Ok(()),
        ExpertLinkState::BlockedByRealDirectory => Err(taken("A folder")),
        ExpertLinkState::LinkedElsewhere => Err(taken("A link to somewhere else")),
        ExpertLinkState::Broken => Err(taken("A broken link")),
    }
}

/// Take our link out of every skill directory of one agent: most built-ins
/// also read the shared `~/.agents/skills`, so it may sit in either, and a
/// disable has to leave the agent without the skill. Anything that is not
/// provably ours stays.
fn unlink_from(central: &Path, dirs: &[PathBuf]) -> io::Result<()> {
    if central_copy_state(central)? != CentralCopy::Ours {
        // Without our marked copy there is nothing a link of ours could
        // resolve to.
        return Ok(());
    }
    for dir in dirs {
        let link = dir.join(SKILL_ID);
        if classify_link(&link, central) != ExpertLinkState::LinkedToCodeg {
            continue;
        }
        remove_skill_entry(&link).map_err(|err| {
            io::Error::new(err.kind(), format!("remove {}: {err}", link.display()))
        })?;
        tracing::info!("[GenerativeUI] unlinked {}", link.display());
    }
    Ok(())
}

/// One cell of the matrix: the link in the agent's preferred directory.
fn status_of(
    agent: AgentType,
    preferred: &Path,
    central: &Path,
    ours: bool,
) -> ExpertInstallStatus {
    let link = preferred.join(SKILL_ID);
    let state = match classify_link(&link, central) {
        // It resolves to a `ui-render` Codeg did not write: the user's own
        // link, which the matrix must neither count as ours nor remove.
        ExpertLinkState::LinkedToCodeg if !ours => ExpertLinkState::LinkedElsewhere,
        state => state,
    };
    ExpertInstallStatus {
        expert_id: SKILL_ID.to_string(),
        agent_type: agent,
        state,
        link_path: link.to_string_lossy().to_string(),
        target_path: read_link_target(&link).map(|p| p.to_string_lossy().to_string()),
        expected_target_path: central.to_string_lossy().to_string(),
        copy_mode: false,
    }
}

fn install_statuses(home: &SkillHome) -> Vec<ExpertInstallStatus> {
    let central = home.central_copy();
    let ours = is_ours(&central);
    home.agents()
        .into_iter()
        .filter_map(|(agent, dirs)| Some(status_of(agent, dirs.first()?, &central, ours)))
        .collect()
}

fn apply_one(home: &SkillHome, op: &LinkOp) -> io::Result<Option<ExpertInstallStatus>> {
    if op.expert_id != SKILL_ID {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("unknown skill: {}", op.expert_id),
        ));
    }
    let dirs = home.agent_dirs(op.agent_type);
    let Some(preferred) = dirs.first() else {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            format!("{:?} has no skill directory", op.agent_type),
        ));
    };
    let central = home.central_copy();
    if op.enable {
        // Also recreates a central copy that went missing, which brings back
        // every link of ours that was dangling for want of it.
        ensure_central_copy(&central)?;
        link_into(&central, preferred)?;
        // Only where the new link went: an old link in a directory this
        // agent shares belongs to the agent whose own directory that is, and
        // waits for its own move.
        retire_legacy_links(home, std::slice::from_ref(preferred))?;
        Ok(Some(status_of(op.agent_type, preferred, &central, true)))
    } else {
        unlink_from(&central, &dirs)?;
        // Everywhere the disable just looked: the agent is left without the
        // skill under either name.
        retire_legacy_links(home, &dirs)?;
        Ok(None)
    }
}

/// A choice made on the settings page for an agent supersedes the move from
/// the old name: whatever `json-render` link of ours its directories still
/// hold goes now, so no later startup acts on it.
fn retire_legacy_links(home: &SkillHome, dirs: &[PathBuf]) -> io::Result<()> {
    let old = home.legacy_copy();
    if central_copy_state(&old)? != CentralCopy::Ours {
        return Ok(());
    }
    for dir in dirs {
        let link = dir.join(LEGACY_SKILL_ID);
        if classify_link(&link, &old) != ExpertLinkState::LinkedToCodeg {
            continue;
        }
        remove_skill_entry(&link).map_err(|err| {
            io::Error::new(err.kind(), format!("remove {}: {err}", link.display()))
        })?;
        tracing::info!("[GenerativeUI] unlinked {}", link.display());
    }
    Ok(())
}

/// Each op on its own: one that fails records its error and the rest go on.
/// The settings page reads every state back afterwards, since a disable can
/// also take the skill from an agent sharing a directory.
fn apply_links_blocking(home: &SkillHome, ops: Vec<LinkOp>) -> Vec<LinkOpResult> {
    ops.into_iter()
        .map(|op| {
            let (ok, status, error) = match apply_one(home, &op) {
                Ok(status) => (true, status, None),
                Err(err) => (false, None, Some(err.to_string())),
            };
            LinkOpResult {
                expert_id: op.expert_id,
                agent_type: op.agent_type,
                ok,
                status,
                error,
            }
        })
        .collect()
}

// ─── Startup ────────────────────────────────────────────────────────────

/// An up-to-date central copy — quietly none while the name belongs to a
/// skill of the user's, which the settings page reports — then the move from
/// the old name. `legacy_switch` is `None` when it could not be read. Returns
/// what went wrong, for the log.
fn install_blocking(home: &SkillHome, legacy_switch: Option<bool>) -> Vec<String> {
    let central = home.central_copy();
    let mut problems = Vec::new();
    if is_foreign(&central) {
        tracing::info!(
            "[GenerativeUI] {} is a skill of the user's; leaving it alone",
            central.display()
        );
    } else if let Err(err) = ensure_central_copy(&central) {
        problems.push(format!("{}: {err}", central.display()));
    }
    problems.extend(migrate_legacy(home, legacy_switch));
    problems
}

/// Move 0.35.0's `json-render` over to `ui-render`.
///
/// With the old switch on, every agent whose preferred skill directory holds
/// our `json-render` link — 0.35.0 linked there, at the agent's launch — gets
/// `ui-render` in that directory. An agent that cannot get it (something else
/// holds the name there) keeps its `json-render`, and a later startup tries
/// again. Every other `json-render` link of ours is removed: from the agents'
/// directories, and from every place the old copy recorded linking (a custom
/// agent that moved its skill directory, a changed `CODEX_HOME`); with the
/// switch off, all of them are. The old copy goes once none is left; until
/// then it stays, so no link of ours dangles.
///
/// With the switch on but our `ui-render` copy unavailable — a skill of the
/// user's holds the name — nothing moves yet: the agents keep `json-render`
/// rather than lose the skill until the name is free. Nothing moves either
/// while the switch cannot be read: unknown is not off.
///
/// What brings `ui-render` back is only a `json-render` link that is still
/// there, and a choice made on the settings page removes the agent's own
/// ([`retire_legacy_links`]): a later startup never undoes that choice.
fn migrate_legacy(home: &SkillHome, switch: Option<bool>) -> Vec<String> {
    let old = home.legacy_copy();
    match central_copy_state(&old) {
        Ok(CentralCopy::Ours) => {}
        // Moved already, or a `json-render` of the user's own: not ours.
        Ok(_) => return Vec::new(),
        Err(err) => return vec![format!("{}: {err}", old.display())],
    }
    let Some(switch_on) = switch else {
        return vec![format!(
            "could not read {LEGACY_SWITCH_KEY}; {LEGACY_SKILL_ID} stays for now"
        )];
    };
    let mut problems = Vec::new();
    let agents = home.agents();
    // Old links that stay, because their agent could not get `ui-render`.
    let mut keep: Vec<PathBuf> = Vec::new();
    if switch_on {
        let central = home.central_copy();
        if !is_ours(&central) {
            tracing::info!(
                "[GenerativeUI] {} is not available; json-render stays for now",
                central.display()
            );
            return problems;
        }
        for (agent, dirs) in &agents {
            let Some(preferred) = dirs.first() else {
                continue;
            };
            let old_link = preferred.join(LEGACY_SKILL_ID);
            if classify_link(&old_link, &old) != ExpertLinkState::LinkedToCodeg {
                continue;
            }
            if let Err(err) = link_into(&central, preferred) {
                problems.push(format!("{agent:?} keeps {LEGACY_SKILL_ID} for now: {err}"));
                if !keep.contains(&old_link) {
                    keep.push(old_link);
                }
            }
        }
    }
    let (failures, left) = unlink_legacy(&old, &every_dir(&agents), &keep);
    if !failures.is_empty() || !left.is_empty() {
        problems.extend(failures);
        return problems;
    }
    match fs::remove_dir_all(&old) {
        Ok(()) => tracing::info!("[GenerativeUI] moved {} over to {SKILL_ID}", old.display()),
        Err(err) => problems.push(format!("{}: {err}", old.display())),
    }
    problems
}

/// The links the old copy recorded. A list that is missing is empty; one
/// that cannot be read is an error, never an empty list — rewriting it from
/// nothing would forget links that still exist.
fn recorded_links(old: &Path) -> io::Result<Vec<PathBuf>> {
    match fs::read_to_string(old.join(LEGACY_LINKS_FILE)) {
        Ok(list) => Ok(list
            .lines()
            .filter(|line| !line.is_empty())
            .map(PathBuf::from)
            .collect()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(err) => Err(err),
    }
}

/// Through a rename, so an interrupted write never loses the list.
fn write_recorded_links(old: &Path, links: &[PathBuf]) -> io::Result<()> {
    let list: String = links
        .iter()
        .map(|link| format!("{}\n", link.display()))
        .collect();
    let partial = old.join(".codeg-links.partial");
    fs::write(&partial, list)?;
    fs::rename(&partial, old.join(LEGACY_LINKS_FILE)).inspect_err(|_| {
        let _ = fs::remove_file(&partial);
    })
}

/// Where an entry really is: its directory resolved through any link on the
/// way, so two spellings of one place (a recorded path through a symlinked
/// `CODEX_HOME`, say) compare equal. The path as given when that fails.
fn entry_identity(path: &Path) -> PathBuf {
    match (path.parent(), path.file_name()) {
        (Some(dir), Some(name)) => fs::canonicalize(dir)
            .map(|dir| dir.join(name))
            .unwrap_or_else(|_| path.to_path_buf()),
        _ => path.to_path_buf(),
    }
}

/// Take every `json-render` link of ours out of `dirs` and out of every place
/// the old copy recorded, except those in `keep`. Only a link resolving to the
/// old copy counts as ours. Returns what failed, and every link of ours left
/// (failed or kept); those stay recorded for the next startup.
fn unlink_legacy(old: &Path, dirs: &[PathBuf], keep: &[PathBuf]) -> (Vec<String>, Vec<PathBuf>) {
    let mut failures = Vec::new();
    // Without the list, every place an agent declares is one we may have
    // linked, and the list itself stays as it is.
    let recorded = match recorded_links(old) {
        Ok(links) => Some(links),
        Err(err) => {
            failures.push(format!("{}: {err}", old.join(LEGACY_LINKS_FILE).display()));
            None
        }
    };
    let mut candidates: Vec<PathBuf> = dirs.iter().map(|dir| dir.join(LEGACY_SKILL_ID)).collect();
    for link in recorded.iter().flatten() {
        if !candidates.contains(link) {
            candidates.push(link.clone());
        }
    }
    let kept: Vec<PathBuf> = keep.iter().map(|link| entry_identity(link)).collect();
    let mut left = Vec::new();
    for link in candidates {
        if kept.contains(&entry_identity(&link)) {
            left.push(link);
            continue;
        }
        // A place we linked that cannot even be looked at (its directory's
        // permissions changed) may still hold our link: say so, and keep it
        // on the list. Elsewhere it only means no link of ours is there.
        if let Err(err) = fs::symlink_metadata(&link) {
            let maybe_ours = recorded.as_ref().is_none_or(|known| known.contains(&link));
            if err.kind() != io::ErrorKind::NotFound && maybe_ours {
                failures.push(format!("{}: {err}", link.display()));
                left.push(link);
            }
            continue;
        }
        if classify_link(&link, old) != ExpertLinkState::LinkedToCodeg {
            continue;
        }
        match remove_skill_entry(&link) {
            Ok(()) => tracing::info!("[GenerativeUI] unlinked {}", link.display()),
            Err(err) => {
                failures.push(format!("{}: {err}", link.display()));
                left.push(link);
            }
        }
    }
    if let Some(recorded) = recorded {
        if left != recorded {
            if let Err(err) = write_recorded_links(old, &left) {
                tracing::warn!("[GenerativeUI] could not update the old link list: {err}");
            }
        }
    }
    (failures, left)
}

// ─── The skill's state ──────────────────────────────────────────────────

struct GenerativeUi {
    /// Held across every write to skill directories — a batch from the
    /// settings page, the startup install — by the blocking half that does
    /// the work, so a caller that goes away midway (an HTTP client hanging
    /// up) cannot let the next one in early.
    lock: Arc<Mutex<()>>,
    home: SkillHome,
}

static GENERATIVE_UI: LazyLock<GenerativeUi> = LazyLock::new(|| GenerativeUi::new(SkillHome::User));

impl GenerativeUi {
    fn new(home: SkillHome) -> Self {
        Self {
            lock: Arc::new(Mutex::new(())),
            home,
        }
    }

    async fn install(&self, legacy_switch: Option<bool>) -> Vec<String> {
        let guard = self.lock.clone().lock_owned().await;
        let home = self.home.clone();
        tokio::task::spawn_blocking(move || {
            let _guard = guard;
            install_blocking(&home, legacy_switch)
        })
        .await
        .unwrap_or_else(|err| vec![format!("install panicked: {err}")])
    }

    async fn apply_links(&self, ops: Vec<LinkOp>) -> Result<Vec<LinkOpResult>, AppCommandError> {
        let guard = self.lock.clone().lock_owned().await;
        let home = self.home.clone();
        tokio::task::spawn_blocking(move || {
            let _guard = guard;
            apply_links_blocking(&home, ops)
        })
        .await
        .map_err(|err| AppCommandError::task_execution_failed(err.to_string()))
    }

    async fn statuses(&self) -> Result<Vec<ExpertInstallStatus>, AppCommandError> {
        let home = self.home.clone();
        tokio::task::spawn_blocking(move || install_statuses(&home))
            .await
            .map_err(|err| AppCommandError::task_execution_failed(err.to_string()))
    }

    async fn skill_info(&self) -> Result<GenerativeUiSkillInfo, AppCommandError> {
        let central = self.home.central_copy();
        let conflict = tokio::task::spawn_blocking(move || is_foreign(&central))
            .await
            .map_err(|err| AppCommandError::task_execution_failed(err.to_string()))?;
        Ok(GenerativeUiSkillInfo {
            id: SKILL_ID.to_string(),
            conflict,
        })
    }
}

/// The 0.35.0 switch: off when it was never set, `None` when the read failed.
async fn load_legacy_switch(conn: &DatabaseConnection) -> Option<bool> {
    match app_metadata_service::get_value(conn, LEGACY_SWITCH_KEY).await {
        Ok(Some(raw)) => Some(raw.parse::<bool>().unwrap_or(false)),
        Ok(None) => Some(false),
        Err(err) => {
            tracing::warn!("[GenerativeUI] could not read {LEGACY_SWITCH_KEY}: {err}");
            None
        }
    }
}

// ─── Entry points ───────────────────────────────────────────────────────

/// Bring the central copy up to date and move 0.35.0's `json-render` over.
/// Run once at startup, before any command is served: a change made on the
/// settings page must come after the move, never be undone by it. Problems
/// are logged, never fatal.
pub async fn install_generative_ui_skill(conn: &DatabaseConnection) {
    let legacy_switch = load_legacy_switch(conn).await;
    let problems = GENERATIVE_UI.install(legacy_switch).await;
    if problems.is_empty() {
        tracing::info!("[GenerativeUI] {SKILL_ID} skill ready");
    } else {
        tracing::warn!(
            "[GenerativeUI] install finished with {} problem(s): {problems:?}",
            problems.len()
        );
    }
}

/// The central-store ids this module owns, for the custom-skills pack to keep
/// out of its list — each only while the copy there is Codeg's. A `ui-render`
/// the user made stays a custom skill they can see, edit and rename.
pub(crate) fn reserved_skill_ids() -> Vec<String> {
    reserved_ids_in(&SkillHome::User)
}

fn reserved_ids_in(home: &SkillHome) -> Vec<String> {
    [
        (SKILL_ID, home.central_copy()),
        (LEGACY_SKILL_ID, home.legacy_copy()),
    ]
    .into_iter()
    .filter(|(_, dir)| is_ours(dir))
    .map(|(id, _)| id.to_string())
    .collect()
}

// -------- Commands (Tauri, and the web handlers call them too) ---------------

/// The skill's name, and whether a skill of the user's holds it.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn generative_ui_skill_info() -> Result<GenerativeUiSkillInfo, AppCommandError> {
    GENERATIVE_UI.skill_info().await
}

/// One state per agent with a skill store: the matrix in one round trip.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn generative_ui_list_all_install_statuses(
) -> Result<Vec<ExpertInstallStatus>, AppCommandError> {
    GENERATIVE_UI.statuses().await
}

/// Enable or disable the skill for a batch of agents; one result per op.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn generative_ui_apply_links(
    ops: Vec<LinkOp>,
) -> Result<Vec<LinkOpResult>, AppCommandError> {
    GENERATIVE_UI.apply_links(ops).await
}

/// The `SKILL.md` agents get, for the settings page's preview.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn generative_ui_read_content() -> Result<String, AppCommandError> {
    Ok(SKILL_MD.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A home of temporary directories: the central store and one skill
    /// directory per agent (Codex's has a second, shared one, like the real
    /// `~/.agents/skills`, which is Gemini's only one).
    struct Fixture {
        _tmp: tempfile::TempDir,
        root: PathBuf,
        ui: GenerativeUi,
    }

    impl Fixture {
        fn new() -> Self {
            let tmp = tempfile::tempdir().expect("tempdir");
            let root = tmp.path().to_path_buf();
            let agents = vec![
                (AgentType::ClaudeCode, vec![root.join("claude/skills")]),
                (
                    AgentType::Codex,
                    vec![root.join("codex/skills"), root.join("agents/skills")],
                ),
                (AgentType::Gemini, vec![root.join("agents/skills")]),
            ];
            let home = SkillHome::Fixed {
                central_root: root.join("central"),
                agents,
            };
            Self {
                _tmp: tmp,
                root,
                ui: GenerativeUi::new(home),
            }
        }

        fn central(&self) -> PathBuf {
            self.ui.home.central_copy()
        }

        fn legacy(&self) -> PathBuf {
            self.ui.home.legacy_copy()
        }

        fn link(&self, agent_dir: &str) -> PathBuf {
            self.root.join(agent_dir).join(SKILL_ID)
        }

        fn legacy_link(&self, agent_dir: &str) -> PathBuf {
            self.root.join(agent_dir).join(LEGACY_SKILL_ID)
        }

        fn is_our_link(&self, agent_dir: &str) -> bool {
            classify_link(&self.link(agent_dir), &self.central()) == ExpertLinkState::LinkedToCodeg
        }

        async fn apply(&self, ops: &[(AgentType, bool)]) -> Vec<LinkOpResult> {
            let ops = ops
                .iter()
                .map(|&(agent_type, enable)| LinkOp {
                    expert_id: SKILL_ID.to_string(),
                    agent_type,
                    enable,
                })
                .collect();
            self.ui.apply_links(ops).await.expect("apply")
        }

        async fn enable(&self, agent: AgentType) -> LinkOpResult {
            self.apply(&[(agent, true)]).await.remove(0)
        }

        async fn disable(&self, agent: AgentType) -> LinkOpResult {
            self.apply(&[(agent, false)]).await.remove(0)
        }

        async fn state_of(&self, agent: AgentType) -> ExpertLinkState {
            self.ui
                .statuses()
                .await
                .unwrap()
                .into_iter()
                .find(|status| status.agent_type == agent)
                .expect("a column for every agent")
                .state
        }

        /// A directory standing where the central copy goes, made by the
        /// user (no marker), with its own content.
        fn plant_users_central_skill(&self) {
            fs::create_dir_all(self.central()).unwrap();
            fs::write(self.central().join("SKILL.md"), "mine\n").unwrap();
        }

        /// What 0.35.0 left: its marked `json-render` copy, linked into the
        /// preferred directories of `agent_dirs`, every link recorded.
        fn plant_legacy(&self, agent_dirs: &[&str]) {
            let old = self.legacy();
            fs::create_dir_all(&old).unwrap();
            fs::write(old.join(MARKER_FILE), "Codeg installs this skill\n").unwrap();
            fs::write(old.join("SKILL.md"), "---\nname: json-render\n---\n").unwrap();
            let mut list = String::new();
            for dir in agent_dirs {
                let dir = self.root.join(dir);
                fs::create_dir_all(&dir).unwrap();
                let link = dir.join(LEGACY_SKILL_ID);
                create_link_raw(&old, &link).unwrap();
                list.push_str(&format!("{}\n", link.display()));
            }
            fs::write(old.join(LEGACY_LINKS_FILE), list).unwrap();
        }

        fn is_our_legacy_link(&self, agent_dir: &str) -> bool {
            classify_link(&self.legacy_link(agent_dir), &self.legacy())
                == ExpertLinkState::LinkedToCodeg
        }
    }

    fn exists(path: &Path) -> bool {
        fs::symlink_metadata(path).is_ok()
    }

    /// An agent finds a skill by its directory, and a user calls it by its
    /// frontmatter name: the two must agree.
    #[test]
    fn the_bundled_skill_is_named_after_its_directory() {
        assert!(SKILL_MD.starts_with(&format!("---\nname: {SKILL_ID}\ndescription: ")));
    }

    /// Every platform ships the bytes `skill.ts` generates. A Windows checkout
    /// converts text to CRLF by default (`core.autocrlf`), which `include_str!`
    /// would compile in as is; `.gitattributes` pins `genui/` to LF.
    #[test]
    fn the_bundled_skill_has_lf_line_endings() {
        assert!(
            !SKILL_MD.contains('\r'),
            "genui/ui-render/SKILL.md was checked out with CRLF; check the \
             `eol=lf` rule for it in .gitattributes"
        );
    }

    #[tokio::test]
    async fn startup_writes_the_central_copy_and_links_nothing() {
        let fx = Fixture::new();
        assert!(fx.ui.install(Some(false)).await.is_empty());

        assert_eq!(
            fs::read_to_string(fx.central().join("SKILL.md")).unwrap(),
            SKILL_MD
        );
        assert!(fx.central().join(MARKER_FILE).is_file());
        for dir in ["claude/skills", "codex/skills", "agents/skills"] {
            assert!(!exists(&fx.root.join(dir)), "{dir} must not be created");
        }
        let statuses = fx.ui.statuses().await.unwrap();
        // One cell per agent with a skill store, each about its preferred dir.
        let columns: Vec<AgentType> = statuses.iter().map(|s| s.agent_type).collect();
        assert_eq!(
            columns,
            vec![AgentType::ClaudeCode, AgentType::Codex, AgentType::Gemini]
        );
        for status in &statuses {
            assert_eq!(status.state, ExpertLinkState::NotLinked, "{status:?}");
            assert_eq!(status.expert_id, SKILL_ID);
        }
        assert_eq!(
            statuses[1].link_path,
            fx.link("codex/skills").to_string_lossy()
        );
    }

    #[tokio::test]
    async fn startup_brings_an_outdated_central_copy_up_to_date() {
        let fx = Fixture::new();
        fx.ui.install(Some(false)).await;
        fs::write(fx.central().join("SKILL.md"), "an older version\n").unwrap();

        fx.ui.install(Some(false)).await;
        assert_eq!(
            fs::read_to_string(fx.central().join("SKILL.md")).unwrap(),
            SKILL_MD
        );
    }

    #[tokio::test]
    async fn a_marker_without_a_skill_is_finished_rather_than_disowned() {
        let fx = Fixture::new();
        // What an install cut short between the marker and SKILL.md leaves.
        fs::create_dir_all(fx.central()).unwrap();
        fs::write(fx.central().join(MARKER_FILE), MARKER_TEXT).unwrap();

        assert!(!fx.ui.skill_info().await.unwrap().conflict);
        fx.ui.install(Some(false)).await;
        assert_eq!(
            fs::read_to_string(fx.central().join("SKILL.md")).unwrap(),
            SKILL_MD
        );
    }

    #[tokio::test]
    async fn enabling_links_the_agents_preferred_dir_and_nothing_else() {
        let fx = Fixture::new();
        // No startup install first: enabling writes the central copy itself.
        let result = fx.enable(AgentType::Codex).await;
        assert!(result.ok, "{result:?}");
        assert_eq!(
            result.status.map(|status| status.state),
            Some(ExpertLinkState::LinkedToCodeg)
        );
        assert!(fx.is_our_link("codex/skills"));
        assert!(!exists(&fx.link("agents/skills")), "only the preferred dir");
        assert!(!exists(&fx.link("claude/skills")), "only that agent");

        assert_eq!(
            fx.state_of(AgentType::Codex).await,
            ExpertLinkState::LinkedToCodeg
        );
        assert_eq!(
            fx.state_of(AgentType::ClaudeCode).await,
            ExpertLinkState::NotLinked
        );
        assert_eq!(
            fx.state_of(AgentType::Gemini).await,
            ExpertLinkState::NotLinked
        );

        // Again: still the one link.
        assert!(fx.enable(AgentType::Codex).await.ok);
        assert!(fx.is_our_link("codex/skills"));
    }

    #[tokio::test]
    async fn enabling_restores_a_central_copy_that_went_missing() {
        let fx = Fixture::new();
        assert!(fx.enable(AgentType::ClaudeCode).await.ok);
        fs::remove_dir_all(fx.central()).unwrap();
        assert_eq!(
            fx.state_of(AgentType::ClaudeCode).await,
            ExpertLinkState::Broken
        );

        assert!(fx.enable(AgentType::ClaudeCode).await.ok);
        assert!(fx.is_our_link("claude/skills"));
    }

    #[tokio::test]
    async fn disabling_takes_our_link_out_of_every_dir_the_agent_reads() {
        let fx = Fixture::new();
        assert!(fx.enable(AgentType::Codex).await.ok);
        assert!(fx.enable(AgentType::Gemini).await.ok);
        assert!(fx.is_our_link("agents/skills"));
        assert!(fx.enable(AgentType::ClaudeCode).await.ok);

        // Codex also reads the shared dir Gemini's link is in: a disable that
        // left it would leave Codex with the skill.
        let result = fx.disable(AgentType::Codex).await;
        assert!(result.ok, "{result:?}");
        assert!(!exists(&fx.link("codex/skills")));
        assert!(!exists(&fx.link("agents/skills")));
        assert!(fx.is_our_link("claude/skills"), "other agents keep theirs");
        assert!(
            fx.central().join("SKILL.md").is_file(),
            "the central copy stays"
        );

        // Again: nothing left to remove, and that is fine.
        assert!(fx.disable(AgentType::Codex).await.ok);
    }

    #[tokio::test]
    async fn whatever_else_holds_the_name_in_an_agent_dir_stays() {
        let fx = Fixture::new();
        fx.ui.install(Some(false)).await;
        // The user's own `ui-render` folder in Claude's skill dir.
        let folder = fx.link("claude/skills");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("SKILL.md"), "theirs\n").unwrap();
        // A link to somewhere else in Codex's, and a dangling one in the
        // shared dir.
        let elsewhere = fx.root.join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        fs::create_dir_all(fx.root.join("codex/skills")).unwrap();
        create_link_raw(&elsewhere, &fx.link("codex/skills")).unwrap();
        let gone = fx.root.join("gone");
        fs::create_dir_all(&gone).unwrap();
        fs::create_dir_all(fx.root.join("agents/skills")).unwrap();
        create_link_raw(&gone, &fx.link("agents/skills")).unwrap();
        fs::remove_dir_all(&gone).unwrap();

        assert_eq!(
            fx.state_of(AgentType::ClaudeCode).await,
            ExpertLinkState::BlockedByRealDirectory
        );
        assert_eq!(
            fx.state_of(AgentType::Codex).await,
            ExpertLinkState::LinkedElsewhere
        );
        assert_eq!(
            fx.state_of(AgentType::Gemini).await,
            ExpertLinkState::Broken
        );

        let results = fx
            .apply(&[
                (AgentType::ClaudeCode, true),
                (AgentType::Codex, true),
                (AgentType::Gemini, true),
            ])
            .await;
        for result in &results {
            assert!(!result.ok, "{result:?}");
            assert!(result.error.as_deref().unwrap().contains("already exists"));
        }
        let results = fx
            .apply(&[
                (AgentType::ClaudeCode, false),
                (AgentType::Codex, false),
                (AgentType::Gemini, false),
            ])
            .await;
        assert!(results.iter().all(|result| result.ok), "{results:?}");

        assert_eq!(
            fs::read_to_string(folder.join("SKILL.md")).unwrap(),
            "theirs\n"
        );
        assert_eq!(
            classify_link(&fx.link("codex/skills"), &elsewhere),
            ExpertLinkState::LinkedToCodeg,
            "the link to somewhere else is still there"
        );
        assert!(exists(&fx.link("agents/skills")), "the dangling link too");
    }

    #[tokio::test]
    async fn a_skill_of_the_users_under_the_name_is_never_taken_over() {
        let fx = Fixture::new();
        fx.plant_users_central_skill();
        // ...which the user already linked into Claude.
        fs::create_dir_all(fx.root.join("claude/skills")).unwrap();
        create_link_raw(&fx.central(), &fx.link("claude/skills")).unwrap();

        assert!(fx.ui.install(Some(false)).await.is_empty());
        assert!(fx.ui.skill_info().await.unwrap().conflict);
        assert_eq!(
            fx.state_of(AgentType::ClaudeCode).await,
            ExpertLinkState::LinkedElsewhere,
            "their link is not ours to show as enabled"
        );

        let enable = fx.enable(AgentType::Codex).await;
        assert!(!enable.ok, "{enable:?}");
        assert!(!exists(&fx.link("codex/skills")), "not linked anywhere");
        assert!(fx.disable(AgentType::ClaudeCode).await.ok);
        assert_eq!(
            classify_link(&fx.link("claude/skills"), &fx.central()),
            ExpertLinkState::LinkedToCodeg,
            "their link to their skill survives"
        );
        assert_eq!(
            fs::read_to_string(fx.central().join("SKILL.md")).unwrap(),
            "mine\n"
        );
        assert!(!fx.central().join(MARKER_FILE).exists());
    }

    #[tokio::test]
    async fn an_op_for_another_skill_or_an_agent_without_skills_fails_alone() {
        let fx = Fixture::new();
        let mut ops = vec![LinkOp {
            expert_id: "something-else".into(),
            agent_type: AgentType::ClaudeCode,
            enable: true,
        }];
        for agent_type in [AgentType::OpenCode, AgentType::ClaudeCode] {
            ops.push(LinkOp {
                expert_id: SKILL_ID.into(),
                agent_type,
                enable: true,
            });
        }
        let results = fx.ui.apply_links(ops).await.unwrap();
        assert_eq!(results.len(), 3);
        assert!(!results[0].ok && results[0].error.is_some(), "{results:?}");
        assert!(!results[1].ok && results[1].error.is_some(), "{results:?}");
        assert!(results[2].ok, "{results:?}");
        assert!(!exists(&fx.root.join("claude/skills/something-else")));
        assert!(fx.is_our_link("claude/skills"));
    }

    #[tokio::test]
    async fn the_old_name_moves_over_while_the_old_switch_was_on() {
        let fx = Fixture::new();
        // 0.35.0 had linked Claude and Codex (each into its preferred dir);
        // Gemini was never started.
        fx.plant_legacy(&["claude/skills", "codex/skills"]);

        assert!(fx.ui.install(Some(true)).await.is_empty());
        assert!(fx.is_our_link("claude/skills"));
        assert!(fx.is_our_link("codex/skills"));
        assert!(!exists(&fx.link("agents/skills")), "Gemini never had it");
        assert!(!exists(&fx.legacy_link("claude/skills")));
        assert!(!exists(&fx.legacy_link("codex/skills")));
        assert!(!exists(&fx.legacy()), "the old copy is gone");
        assert_eq!(
            fx.state_of(AgentType::ClaudeCode).await,
            ExpertLinkState::LinkedToCodeg
        );
        assert_eq!(
            fx.state_of(AgentType::Gemini).await,
            ExpertLinkState::NotLinked
        );

        // Nothing left to move: a second startup changes nothing.
        assert!(fx.ui.install(Some(true)).await.is_empty());
        assert!(fx.is_our_link("claude/skills"));
    }

    #[tokio::test]
    async fn with_the_old_switch_off_the_old_links_just_go() {
        let fx = Fixture::new();
        // Switched off in 0.35.0, but one link outlived the cleanup.
        fx.plant_legacy(&["claude/skills"]);

        assert!(fx.ui.install(Some(false)).await.is_empty());
        assert!(!exists(&fx.legacy_link("claude/skills")));
        assert!(!exists(&fx.link("claude/skills")), "off stays off");
        assert!(!exists(&fx.legacy()));
    }

    #[tokio::test]
    async fn a_recorded_link_where_no_agent_looks_any_more_is_removed_too() {
        let fx = Fixture::new();
        // Linked under a skill dir Claude no longer uses (a moved
        // CLAUDE_CONFIG_DIR): only the old copy's list knows it.
        fx.plant_legacy(&["moved/skills"]);

        assert!(fx.ui.install(Some(true)).await.is_empty());
        assert!(!exists(&fx.legacy_link("moved/skills")));
        assert!(!exists(&fx.link("moved/skills")), "nobody reads that dir");
        assert!(!exists(&fx.legacy()));
    }

    #[tokio::test]
    async fn json_render_links_that_are_not_ours_stay() {
        let fx = Fixture::new();
        fx.plant_legacy(&["claude/skills"]);
        // A `json-render` link to somewhere else, and a folder of that name.
        let elsewhere = fx.root.join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        fs::create_dir_all(fx.root.join("agents/skills")).unwrap();
        create_link_raw(&elsewhere, &fx.legacy_link("agents/skills")).unwrap();
        fs::create_dir_all(fx.legacy_link("codex/skills")).unwrap();

        assert!(fx.ui.install(Some(true)).await.is_empty());
        assert!(!exists(&fx.legacy_link("claude/skills")));
        assert_eq!(
            classify_link(&fx.legacy_link("agents/skills"), &elsewhere),
            ExpertLinkState::LinkedToCodeg
        );
        assert!(fx.legacy_link("codex/skills").is_dir());
        assert!(!exists(&fx.link("agents/skills")), "Gemini never had ours");
        assert!(!exists(&fx.link("codex/skills")), "nor did Codex");
    }

    #[tokio::test]
    async fn a_json_render_of_the_users_own_is_left_alone() {
        let fx = Fixture::new();
        fs::create_dir_all(fx.legacy()).unwrap();
        fs::write(fx.legacy().join("SKILL.md"), "mine\n").unwrap();
        fs::create_dir_all(fx.root.join("claude/skills")).unwrap();
        create_link_raw(&fx.legacy(), &fx.legacy_link("claude/skills")).unwrap();

        assert!(fx.ui.install(Some(true)).await.is_empty());
        assert!(exists(&fx.legacy_link("claude/skills")));
        assert_eq!(
            fs::read_to_string(fx.legacy().join("SKILL.md")).unwrap(),
            "mine\n"
        );
        assert!(!exists(&fx.link("claude/skills")));
    }

    #[tokio::test]
    async fn the_move_waits_while_a_skill_of_the_users_holds_the_new_name() {
        let fx = Fixture::new();
        fx.plant_users_central_skill();
        fx.plant_legacy(&["claude/skills"]);

        fx.ui.install(Some(true)).await;
        assert!(fx.is_our_legacy_link("claude/skills"), "keeps json-render");
        assert!(!exists(&fx.link("claude/skills")));
        assert!(fx.legacy().join(MARKER_FILE).is_file());
    }

    /// A switch that could not be read is not taken for "off": the agents
    /// keep `json-render`, and the next startup reads again.
    #[tokio::test]
    async fn nothing_moves_while_the_old_switch_cannot_be_read() {
        let fx = Fixture::new();
        fx.plant_legacy(&["claude/skills"]);

        let problems = fx.ui.install(None).await;
        assert!(
            problems.iter().any(|p| p.contains(LEGACY_SWITCH_KEY)),
            "{problems:?}"
        );
        assert!(fx.is_our_legacy_link("claude/skills"), "keeps json-render");
        assert!(!exists(&fx.link("claude/skills")));
        assert!(fx.central().join("SKILL.md").is_file(), "still installed");

        assert!(fx.ui.install(Some(true)).await.is_empty());
        assert!(fx.is_our_link("claude/skills"));
        assert!(!exists(&fx.legacy()));
    }

    /// An agent that cannot get `ui-render` — something else holds the name
    /// in its directory — keeps `json-render`, and a later startup tries
    /// again; the old copy stays for it until then.
    #[tokio::test]
    async fn an_agent_the_move_cannot_reach_keeps_json_render_until_it_can() {
        let fx = Fixture::new();
        // Gemini's preferred dir is the shared one, where a folder already
        // holds the new name.
        fx.plant_legacy(&["claude/skills", "agents/skills"]);
        let blocker = fx.link("agents/skills");
        fs::create_dir_all(&blocker).unwrap();

        let problems = fx.ui.install(Some(true)).await;
        assert_eq!(problems.len(), 1, "{problems:?}");
        assert!(fx.is_our_link("claude/skills"));
        assert!(!exists(&fx.legacy_link("claude/skills")));
        assert!(fx.is_our_legacy_link("agents/skills"), "keeps json-render");
        assert!(exists(&fx.legacy()), "the old copy stays for it");
        assert_eq!(
            recorded_links(&fx.legacy()).unwrap(),
            vec![fx.legacy_link("agents/skills")]
        );

        fs::remove_dir(&blocker).unwrap();
        assert!(fx.ui.install(Some(true)).await.is_empty());
        assert!(fx.is_our_link("agents/skills"));
        assert!(!exists(&fx.legacy_link("agents/skills")));
        assert!(!exists(&fx.legacy()));
    }

    /// What the user picks on the settings page for an agent takes that
    /// agent's `json-render` away at once, so no later startup undoes it.
    #[tokio::test]
    async fn a_choice_made_on_the_settings_page_outlasts_the_move() {
        let fx = Fixture::new();
        fx.plant_legacy(&["claude/skills", "agents/skills"]);
        let blocker = fx.link("agents/skills");
        fs::create_dir_all(&blocker).unwrap();
        fx.ui.install(Some(true)).await;
        assert!(fx.is_our_link("claude/skills"));
        // An old link of Claude's still there (its removal failed, say).
        create_link_raw(&fx.legacy(), &fx.legacy_link("claude/skills")).unwrap();

        // Claude: turned off. Gemini: name freed, then turned on.
        assert!(fx.disable(AgentType::ClaudeCode).await.ok);
        assert!(
            !exists(&fx.legacy_link("claude/skills")),
            "the disable takes it too"
        );
        fs::remove_dir(&blocker).unwrap();
        assert!(fx.enable(AgentType::Gemini).await.ok);
        assert!(
            !exists(&fx.legacy_link("agents/skills")),
            "ui-render replaces it"
        );

        assert!(fx.ui.install(Some(true)).await.is_empty());
        assert!(!exists(&fx.link("claude/skills")), "the disable stands");
        assert!(fx.is_our_link("agents/skills"));
        assert!(!exists(&fx.legacy()), "nothing left to move");
    }

    /// Enabling one agent takes no `json-render` from another: an old link in
    /// a directory it shares is that other agent's, still waiting for its move.
    #[tokio::test]
    async fn enabling_an_agent_leaves_another_agents_old_link_alone() {
        let fx = Fixture::new();
        // Gemini's own (preferred) dir is the shared one Codex also reads;
        // Gemini cannot get ui-render there yet.
        fx.plant_legacy(&["agents/skills"]);
        fs::create_dir_all(fx.link("agents/skills")).unwrap();
        fx.ui.install(Some(true)).await;
        assert!(fx.is_our_legacy_link("agents/skills"));

        assert!(fx.enable(AgentType::Codex).await.ok);
        assert!(fx.is_our_link("codex/skills"));
        assert!(
            fx.is_our_legacy_link("agents/skills"),
            "Gemini keeps its json-render"
        );
    }

    /// A link kept for its agent is kept under any spelling of its place —
    /// here the old copy recorded it through a symlinked home.
    #[tokio::test]
    async fn a_kept_link_survives_an_alias_on_the_list() {
        let fx = Fixture::new();
        fs::create_dir_all(fx.root.join("codex")).unwrap();
        create_link_raw(&fx.root.join("codex"), &fx.root.join("codex-alias")).unwrap();
        // Recorded as codex-alias/skills/json-render; it is Codex's own.
        fx.plant_legacy(&["codex-alias/skills"]);
        fs::create_dir_all(fx.link("codex/skills")).unwrap();

        let problems = fx.ui.install(Some(true)).await;
        assert_eq!(problems.len(), 1, "{problems:?}");
        assert!(fx.is_our_legacy_link("codex/skills"), "keeps json-render");
        assert!(exists(&fx.legacy()));
    }

    /// An old copy that cannot be looked at may be ours: a disable that
    /// could not check says so instead of leaving a link a later startup
    /// would act on.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_disable_that_cannot_check_the_old_copy_says_so() {
        use std::os::unix::fs::PermissionsExt;

        let fx = Fixture::new();
        assert!(fx.enable(AgentType::ClaudeCode).await.ok);
        fx.plant_legacy(&["claude/skills"]);
        let old = fx.legacy();
        fs::set_permissions(&old, fs::Permissions::from_mode(0o000)).unwrap();
        if fs::metadata(old.join(MARKER_FILE)).is_ok() {
            // Running as root: permissions do not stop anything here.
            fs::set_permissions(&old, fs::Permissions::from_mode(0o755)).unwrap();
            return;
        }

        let result = fx.disable(AgentType::ClaudeCode).await;
        fs::set_permissions(&old, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(!result.ok, "{result:?}");
        assert!(fx.is_our_legacy_link("claude/skills"));
    }

    /// An old link that cannot be removed keeps the old copy — so it does
    /// not dangle — and its place on the list, and the next startup retries.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_old_link_that_cannot_be_removed_is_retried_next_startup() {
        use std::os::unix::fs::PermissionsExt;

        let fx = Fixture::new();
        fx.plant_legacy(&["claude/skills", "codex/skills"]);
        let dir = fx.root.join("claude/skills");
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();
        if fs::write(dir.join("probe"), "").is_ok() {
            // Running as root: permissions do not stop anything here.
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
            return;
        }

        let problems = fx.ui.install(Some(false)).await;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(problems.len(), 1, "{problems:?}");
        assert!(
            problems[0].contains("claude/skills/json-render"),
            "{problems:?}"
        );
        assert!(fx.is_our_legacy_link("claude/skills"), "still resolves");
        assert!(!exists(&fx.legacy_link("codex/skills")));
        assert_eq!(
            recorded_links(&fx.legacy()).unwrap(),
            vec![fx.legacy_link("claude/skills")]
        );

        assert!(fx.ui.install(Some(false)).await.is_empty());
        assert!(!exists(&fx.legacy_link("claude/skills")));
        assert!(!exists(&fx.legacy()));
    }

    /// A list that cannot be read is never rewritten from nothing, and keeps
    /// the old copy until a later startup can read it.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_unreadable_old_link_list_keeps_the_old_copy() {
        use std::os::unix::fs::PermissionsExt;

        let fx = Fixture::new();
        fx.plant_legacy(&["claude/skills"]);
        let list = fx.legacy().join(LEGACY_LINKS_FILE);
        fs::set_permissions(&list, fs::Permissions::from_mode(0o000)).unwrap();
        if fs::read_to_string(&list).is_ok() {
            // Running as root: permissions do not stop anything here.
            fs::set_permissions(&list, fs::Permissions::from_mode(0o644)).unwrap();
            return;
        }

        let problems = fx.ui.install(Some(false)).await;
        fs::set_permissions(&list, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(
            problems.iter().any(|p| p.contains(LEGACY_LINKS_FILE)),
            "{problems:?}"
        );
        assert!(
            !exists(&fx.legacy_link("claude/skills")),
            "declared dirs still cleaned"
        );
        assert!(exists(&fx.legacy()), "the old copy waits for the list");
        assert_eq!(
            recorded_links(&fx.legacy()).unwrap(),
            vec![fx.legacy_link("claude/skills")],
            "the list was left alone"
        );
    }

    #[test]
    fn only_marked_copies_reserve_their_names() {
        let tmp = tempfile::tempdir().unwrap();
        let home = SkillHome::Fixed {
            central_root: tmp.path().to_path_buf(),
            agents: Vec::new(),
        };
        assert!(reserved_ids_in(&home).is_empty(), "absent");

        for dir in [home.central_copy(), home.legacy_copy()] {
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("SKILL.md"), "mine\n").unwrap();
        }
        assert!(reserved_ids_in(&home).is_empty(), "the user's own");

        fs::write(home.central_copy().join(MARKER_FILE), MARKER_TEXT).unwrap();
        assert_eq!(reserved_ids_in(&home), vec![SKILL_ID.to_string()]);
        fs::write(home.legacy_copy().join(MARKER_FILE), MARKER_TEXT).unwrap();
        assert_eq!(
            reserved_ids_in(&home),
            vec![SKILL_ID.to_string(), LEGACY_SKILL_ID.to_string()]
        );
    }

    /// The settings page draws one column per agent with a skill store; one
    /// missing here would show a cell whose state never arrives. Built-ins
    /// only: custom agents come and go with the process-wide registry, which
    /// other tests hydrate in parallel.
    #[test]
    fn every_skills_capable_builtin_gets_a_column() {
        let columns = SkillHome::User.agents();
        for agent in crate::acp::registry::builtin_acp_agents() {
            if skill_storage_spec(agent).is_none() {
                continue;
            }
            let dirs = columns.iter().find(|(a, _)| *a == agent).map(|(_, d)| d);
            assert!(
                dirs.is_some_and(|dirs| !dirs.is_empty()),
                "{agent:?} has no column"
            );
        }
    }
}
