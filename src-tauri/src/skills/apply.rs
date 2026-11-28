//! Planning and carrying out link operations: `skills_apply_links`,
//! `skills_repair_link`, and the older packs' `*_apply_links` (through
//! [`super::legacy`]).
//!
//! **Plan first.** Every operation is planned against a view of the disk
//! with the earlier operations' changes laid over it ([`World`]), so a
//! request's effects are known before anything is written: what would be
//! created, removed and moved, and which other agents gain the skill, lose
//! it, or have their directories changed while keeping it.
//!
//! **Nothing that affects another agent happens unasked.** An operation with
//! such effects carries an `ack`: a hash of exactly those effects (and the
//! operation). The real run plans again and refuses — writing nothing —
//! unless each such operation sends back the `ack` its effects have now. A
//! UI that showed older effects sends an older hash, so it cannot confirm
//! effects it never showed (`effects_changed`); one that showed none sends
//! none (`acknowledgement_required`).
//!
//! **All of it or none of it.** Any blocked operation stops the request
//! before a write. A write that fails puts back what was done, in reverse;
//! the link record is written last, and a failure there puts everything back
//! too.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::models::agent::AgentType;

use super::copies::{self, StagedRemoval, StagedSwap};
use super::link::{self, inspect, LinkMode, RawEntry};
use super::model::{
    codes, ApplyOutcome, ChangeKind, DirRole, OpStatus, PathChange, PathMove, RepairAction,
    SkillAction, SkillOp, SkillOpResult, SkillsApplyRequest, SkillsApplyResult, SkillsIssue,
    SkillsRepairResult,
};
use super::record::{now, RecordEntry};
use super::world::{Entry, World};
use super::SkillsCtx;

/// One change on disk.
#[derive(Debug, Clone)]
pub(crate) enum Step {
    /// A link (or, where no link can be made and copies may stand in, a
    /// copy) at `path`, to the store's `skill`.
    CreateLink {
        path: PathBuf,
        dir: PathBuf,
        skill: String,
    },
    /// Remove Codeg's link at `path`; `target` is what it read, for undoing.
    RemoveLink {
        path: PathBuf,
        target: Option<PathBuf>,
    },
    /// Remove Codeg's copy at `path` (it matches its record).
    RemoveCopy { path: PathBuf, skill: String },
    /// Replace Codeg's copy at `path` with the store's `skill`, backing the
    /// old one up first when `backup_as` names the agent.
    ReplaceCopy {
        path: PathBuf,
        skill: String,
        backup_as: Option<String>,
    },
}

impl Step {
    pub fn path(&self) -> &Path {
        match self {
            Step::CreateLink { path, .. }
            | Step::RemoveLink { path, .. }
            | Step::RemoveCopy { path, .. }
            | Step::ReplaceCopy { path, .. } => path,
        }
    }

    pub fn dir(&self) -> PathBuf {
        self.path()
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_default()
    }
}

#[derive(Debug, Clone, Default)]
pub(crate) struct Plan {
    pub steps: Vec<Step>,
    pub creates: Vec<PathChange>,
    pub removes: Vec<PathChange>,
    pub moves: Vec<PathMove>,
    pub gains: Vec<AgentType>,
    pub loses: Vec<AgentType>,
    pub touches: Vec<AgentType>,
    pub issues: Vec<SkillsIssue>,
    pub warnings: Vec<SkillsIssue>,
}

impl Plan {
    pub fn blocked(&self) -> bool {
        !self.issues.is_empty()
    }

    pub fn needs_ack(&self) -> bool {
        !self.gains.is_empty() || !self.loses.is_empty() || !self.touches.is_empty()
    }

    fn issue(&mut self, issue: SkillsIssue) {
        self.issues.push(issue);
    }

    fn warn(&mut self, warning: SkillsIssue) {
        self.warnings.push(warning);
    }

    fn create(&mut self, step: Step, kind: ChangeKind) {
        self.creates.push(change(step.path(), kind));
        self.steps.push(step);
    }

    fn remove(&mut self, step: Step, kind: ChangeKind) {
        self.removes.push(change(step.path(), kind));
        self.steps.push(step);
    }

    /// The acknowledgement of exactly these effects of this operation.
    pub fn ack_token(&self, subject: &str, agent: Option<AgentType>, action: &str) -> String {
        let mut text = format!(
            "skills-ack/1\n{subject}\n{}\n{action}\n",
            agent.map(|a| a.as_wire().into_owned()).unwrap_or_default()
        );
        let mut lines: Vec<String> = Vec::new();
        for c in &self.creates {
            lines.push(format!("create {:?} {}", c.kind, c.path));
        }
        for r in &self.removes {
            lines.push(format!("remove {:?} {}", r.kind, r.path));
        }
        for m in &self.moves {
            lines.push(format!("move {} {}", m.from, m.to));
        }
        lines.sort();
        for (label, agents) in [
            ("gains", &self.gains),
            ("loses", &self.loses),
            ("touches", &self.touches),
        ] {
            let mut names: Vec<String> = agents.iter().map(|a| a.as_wire().into_owned()).collect();
            names.sort();
            lines.push(format!("{label} {}", names.join(",")));
        }
        text.push_str(&lines.join("\n"));
        crate::commands::mcp_engine::fsio::sha256_hex(text.as_bytes())
    }
}

fn change(path: &Path, kind: ChangeKind) -> PathChange {
    PathChange {
        path: path.to_string_lossy().into_owned(),
        kind,
    }
}

/// Why nothing can be put at `target`, when something is there.
pub(crate) fn occupied_issue(entry: &Entry, target: &Path) -> Option<SkillsIssue> {
    let issue = match entry {
        Entry::Absent => return None,
        Entry::Folder | Entry::File | Entry::CodegCopy { .. } => {
            SkillsIssue::new(codes::TARGET_OCCUPIED)
        }
        Entry::CodegLink { broken: false, .. } | Entry::ForeignLink { broken: false, .. } => {
            let issue = SkillsIssue::new(codes::TARGET_LINKED_ELSEWHERE);
            match entry.target() {
                Some(t) => issue.detail(t.to_string_lossy().into_owned()),
                None => issue,
            }
        }
        Entry::CodegLink { broken: true, .. } | Entry::ForeignLink { broken: true, .. } => {
            SkillsIssue::new(codes::TARGET_BROKEN)
        }
        Entry::Owned { plugin, .. } => SkillsIssue::new(codes::PLUGIN_OWNED).detail(plugin.clone()),
        Entry::Unreadable(err) => SkillsIssue::new(codes::IO_ERROR).detail(err.clone()),
    };
    Some(issue.path(target))
}

fn validate(id: &str) -> Result<String, SkillsIssue> {
    crate::commands::acp::validate_skill_id(id)
        .map_err(|e| SkillsIssue::new(codes::SKILL_INVALID).detail(e.to_string()))
}

fn readers_except(world: &World, dir: &Path, agent: AgentType) -> Vec<AgentType> {
    world
        .ctx
        .dir_info(dir)
        .map(|info| {
            info.readers
                .iter()
                .copied()
                .filter(|a| *a != agent)
                .collect()
        })
        .unwrap_or_default()
}

fn plan_enable(world: &World, agent: AgentType, skill: &str, plan: &mut Plan) {
    let source = world.ctx.skill_path(skill);
    if !world.store_has(skill) {
        plan.issue(SkillsIssue::new(codes::SKILL_NOT_FOUND).path(&source));
        return;
    }
    if let Some(visible) = world.visible(agent, skill) {
        plan.warn(SkillsIssue::new(codes::ALREADY_VISIBLE).path(&visible.path));
        return;
    }
    let Some((dir, shared)) = world.ctx.link_dir(agent) else {
        plan.issue(SkillsIssue::new(codes::AGENT_UNSUPPORTED));
        return;
    };
    let target = dir.join(skill);
    if let Some(issue) = occupied_issue(&world.entry(&target), &target) {
        plan.issue(issue);
        return;
    }
    // A Harness plugin provides the name to this agent — or, through a
    // shared directory, to another that would see this one too: never two
    // providers of one name.
    let mut audience = vec![agent];
    if shared {
        audience.extend(readers_except(world, &dir, agent));
    }
    for reader in audience {
        for (path, _, _, entry) in world.entries_of(reader, skill) {
            if let Some(plugin) = entry.plugin() {
                plan.issue(
                    SkillsIssue::new(codes::PLUGIN_OWNED)
                        .path(&path)
                        .detail(plugin),
                );
                return;
            }
        }
    }
    for (path, _, _, entry) in world.entries_of(agent, skill) {
        if !entry.is_codeg_of(skill) && path != target {
            plan.warn(SkillsIssue::new(codes::NAME_ALSO_ELSEWHERE).path(&path));
        }
    }
    plan.create(
        Step::CreateLink {
            path: target,
            dir: dir.clone(),
            skill: skill.to_string(),
        },
        ChangeKind::Link,
    );
    if shared {
        let others = readers_except(world, &dir, agent);
        plan.warn(
            SkillsIssue::new(codes::SHARED_DIRECTORY)
                .path(&dir)
                .agents(others.clone()),
        );
        consolidate_into_shared(world, &others, skill, plan);
    }
}

/// An agent never gets two. Codeg's skill is about to appear in a shared
/// directory that `readers` read: their own links and matching copies of it
/// go (they see it through the shared directory instead). A copy one of them
/// changed cannot go without losing the change, and cannot stay without that
/// agent seeing the skill twice: the operation is blocked (`copy_modified`,
/// `agents` = whose copy) until that copy is refreshed or removed.
fn consolidate_into_shared(world: &World, readers: &[AgentType], skill: &str, plan: &mut Plan) {
    for &other in readers {
        for (info, role) in world.ctx.dirs_of(other) {
            if role != DirRole::Own {
                continue;
            }
            let path = info.path.join(skill);
            match world.entry(&path) {
                Entry::CodegLink {
                    skill: s,
                    broken: false,
                    target,
                } if s == skill => {
                    plan.remove(Step::RemoveLink { path, target }, ChangeKind::Link);
                }
                Entry::CodegCopy {
                    skill: s,
                    matches: true,
                    ..
                } if s == skill => {
                    plan.remove(
                        Step::RemoveCopy {
                            path,
                            skill: skill.to_string(),
                        },
                        ChangeKind::Copy,
                    );
                }
                Entry::CodegCopy {
                    skill: s,
                    matches: false,
                    ..
                } if s == skill => {
                    plan.issue(
                        SkillsIssue::new(codes::COPY_MODIFIED)
                            .path(&path)
                            .agents(vec![other]),
                    );
                }
                _ => {}
            }
        }
    }
}

fn plan_disable(world: &World, agent: AgentType, skill: &str, plan: &mut Plan) {
    for (info, role) in world.ctx.dirs_of(agent) {
        let path = info.path.join(skill);
        match world.entry(&path) {
            Entry::CodegLink {
                skill: s,
                broken: false,
                target,
            } if s == skill => {
                plan.remove(Step::RemoveLink { path, target }, ChangeKind::Link);
            }
            // A broken link of Codeg's under the name shows nobody anything;
            // it goes too, unless it is in a directory other agents read.
            Entry::CodegLink {
                broken: true,
                target,
                ..
            } if role != DirRole::Shared => {
                plan.remove(Step::RemoveLink { path, target }, ChangeKind::BrokenLink);
            }
            Entry::CodegCopy {
                skill: s,
                matches: true,
                ..
            } if s == skill => {
                plan.remove(
                    Step::RemoveCopy {
                        path,
                        skill: skill.to_string(),
                    },
                    ChangeKind::Copy,
                );
            }
            Entry::CodegCopy {
                skill: s,
                matches: false,
                ..
            } if s == skill => {
                plan.warn(SkillsIssue::new(codes::COPY_MODIFIED_KEPT).path(&path));
            }
            // A Harness plugin's skill of that name stays: it goes only
            // with the plugin. Said, not refused (turning a skill off
            // everywhere must not stop at it).
            Entry::Owned { plugin, .. } => {
                plan.warn(
                    SkillsIssue::new(codes::PLUGIN_OWNED)
                        .path(&path)
                        .detail(plugin),
                );
            }
            _ => {}
        }
    }
}

fn plan_only(world: &World, agent: AgentType, skill: &str, plan: &mut Plan) {
    let source = world.ctx.skill_path(skill);
    if !source.is_dir() {
        plan.issue(SkillsIssue::new(codes::SKILL_NOT_FOUND).path(&source));
        return;
    }
    let Some(own) = world.ctx.own_dir(agent) else {
        plan.issue(SkillsIssue::new(codes::NO_OWN_DIRECTORY));
        return;
    };
    let shared: Vec<(PathBuf, Entry)> = world
        .ctx
        .dirs_of(agent)
        .into_iter()
        .filter(|(_, role)| *role == DirRole::Shared)
        .map(|(info, _)| info.path.join(skill))
        .map(|path| {
            let entry = world.entry(&path);
            (path, entry)
        })
        .filter(|(_, entry)| entry.is_codeg_of(skill))
        .collect();
    let own_path = own.join(skill);
    let own_entry = world.entry(&own_path);
    let own_has = own_entry.is_codeg_of(skill);
    if shared.is_empty() {
        if !own_has && world.visible(agent, skill).is_none() {
            plan.issue(SkillsIssue::new(codes::NOT_VISIBLE));
        }
        return;
    }
    if !own_has {
        if let Some(issue) = occupied_issue(&own_entry, &own_path) {
            plan.issue(issue);
            return;
        }
    }
    for (path, entry) in &shared {
        if let Entry::CodegCopy { matches: false, .. } = entry {
            plan.issue(SkillsIssue::new(codes::COPY_MODIFIED).path(path));
        }
    }
    if plan.blocked() {
        return;
    }
    let single_move = !own_has && shared.len() == 1;
    if !own_has {
        let step = Step::CreateLink {
            path: own_path.clone(),
            dir: own.clone(),
            skill: skill.to_string(),
        };
        if single_move {
            plan.steps.push(step);
        } else {
            plan.create(step, ChangeKind::Link);
        }
    }
    for (path, entry) in shared {
        let (step, kind) = match entry {
            Entry::CodegCopy { .. } => (
                Step::RemoveCopy {
                    path: path.clone(),
                    skill: skill.to_string(),
                },
                ChangeKind::Copy,
            ),
            other => (
                Step::RemoveLink {
                    path: path.clone(),
                    target: other.target().map(Path::to_path_buf),
                },
                ChangeKind::Link,
            ),
        };
        if single_move {
            plan.moves.push(PathMove {
                from: path.to_string_lossy().into_owned(),
                to: own_path.to_string_lossy().into_owned(),
            });
            plan.steps.push(step);
        } else {
            plan.remove(step, kind);
        }
    }
}

pub(crate) fn agent_label(agent: AgentType) -> String {
    agent
        .as_wire()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '-'
            }
        })
        .collect()
}

fn plan_refresh(
    world: &World,
    agent: AgentType,
    skill: &str,
    replace_modified: bool,
    plan: &mut Plan,
) {
    let source = world.ctx.skill_path(skill);
    if !source.is_dir() {
        plan.issue(SkillsIssue::new(codes::SKILL_NOT_FOUND).path(&source));
        return;
    }
    let mut found = false;
    for (info, _) in world.ctx.dirs_of(agent) {
        let path = info.path.join(skill);
        let Entry::CodegCopy {
            skill: s,
            matches,
            current,
        } = world.entry(&path)
        else {
            continue;
        };
        if s != skill {
            continue;
        }
        found = true;
        if !matches {
            if replace_modified {
                plan.removes.push(change(&path, ChangeKind::Copy));
                plan.create(
                    Step::ReplaceCopy {
                        path,
                        skill: skill.to_string(),
                        backup_as: Some(agent_label(agent)),
                    },
                    ChangeKind::Copy,
                );
            } else {
                plan.issue(SkillsIssue::new(codes::COPY_MODIFIED).path(&path));
            }
        } else if !current {
            plan.removes.push(change(&path, ChangeKind::Copy));
            plan.create(
                Step::ReplaceCopy {
                    path,
                    skill: skill.to_string(),
                    backup_as: None,
                },
                ChangeKind::Copy,
            );
        }
    }
    if !found {
        plan.warn(SkillsIssue::new(codes::NO_COPY));
    }
}

/// The UI pack's one extra (`commands::generative_ui`): a choice made for an
/// agent about Codeg's `ui-render` retires Codeg 0.35.0's `json-render`
/// links where the choice reached — the directories the operation changes
/// and the agent's own — so the startup move never undoes it. Planned like
/// any other removal: listed in `removes`, covered by the `ack`, counted in
/// the effects. Only while `ui-render` is the UI pack's and `json-render` is
/// Codeg's old copy (each by its marker): a skill of the user's under either
/// name is never a reason to touch the other. Returns whether it planned
/// any.
fn plan_ui_legacy(
    world: &World,
    agent: AgentType,
    skill: &str,
    action: SkillAction,
    plan: &mut Plan,
) -> bool {
    use super::provenance::{UI_IDS, UI_MARKER};
    let [current, old] = UI_IDS;
    if skill != current || action == SkillAction::Refresh {
        return false;
    }
    if world.provenance.origin_of(&world.ctx.store, current) != Some(super::model::SkillOrigin::Ui)
    {
        return false;
    }
    let mut dirs: Vec<PathBuf> = plan.steps.iter().map(Step::dir).collect();
    dirs.extend(
        world
            .ctx
            .dirs_of(agent)
            .into_iter()
            .filter(|(_, role)| *role == DirRole::Own)
            .map(|(info, _)| info.path.clone()),
    );
    let mut seen: BTreeSet<PathBuf> = BTreeSet::new();
    let links: Vec<(PathBuf, Option<PathBuf>)> = dirs
        .into_iter()
        .filter(|dir| seen.insert(super::fsio::normalize(dir)))
        .filter_map(|dir| {
            let path = dir.join(old);
            match world.entry(&path) {
                Entry::CodegLink {
                    skill: s,
                    broken: false,
                    target,
                } if s == old => Some((path, target)),
                _ => None,
            }
        })
        .collect();
    if links.is_empty() {
        return false;
    }
    // Codeg's old copy, by its marker — one that cannot even be looked at
    // may be Codeg's: say so rather than leave or take links by a guess.
    let marker = world.ctx.skill_path(old).join(UI_MARKER);
    match fs::metadata(&marker) {
        Ok(meta) if meta.is_file() => {}
        Err(err) if err.kind() != std::io::ErrorKind::NotFound => {
            plan.issue(
                SkillsIssue::new(codes::IO_ERROR)
                    .path(&marker)
                    .detail(err.to_string()),
            );
            return false;
        }
        _ => return false,
    }
    for (path, target) in links {
        plan.remove(Step::RemoveLink { path, target }, ChangeKind::Link);
    }
    true
}

/// Lay a plan's steps over the view.
fn lay_over(world: &mut World, steps: &[Step]) {
    for step in steps {
        match step {
            Step::CreateLink { path, skill, .. } => {
                let target = world.ctx.skill_path(skill);
                world.set(
                    path,
                    Entry::CodegLink {
                        skill: skill.clone(),
                        target: Some(target),
                        broken: false,
                    },
                );
            }
            Step::RemoveLink { path, .. } | Step::RemoveCopy { path, .. } => {
                world.set(path, Entry::Absent);
            }
            Step::ReplaceCopy { path, skill, .. } => world.set(
                path,
                Entry::CodegCopy {
                    skill: skill.clone(),
                    matches: true,
                    current: true,
                },
            ),
        }
    }
}

/// Fill in who else the plan affects, comparing who sees `skill` before and
/// after its steps; `me` is the agent the operation is for.
fn settle_effects(world: &mut World, plan: &mut Plan, skills: &[String], me: Option<AgentType>) {
    let seen = |world: &World| -> BTreeSet<(AgentType, String)> {
        skills
            .iter()
            .flat_map(|skill| {
                world
                    .seen_by(skill)
                    .into_iter()
                    .map(move |agent| (agent, skill.clone()))
            })
            .collect()
    };
    let before = seen(world);
    lay_over(world, &plan.steps);
    let after = seen(world);
    let not_me = |agent: &AgentType| Some(*agent) != me;
    let mut gains: BTreeSet<AgentType> = after
        .difference(&before)
        .map(|(agent, _)| *agent)
        .filter(not_me)
        .collect();
    let mut loses: BTreeSet<AgentType> = before
        .difference(&after)
        .map(|(agent, _)| *agent)
        .filter(not_me)
        .collect();
    // An agent that loses one skill and gains another (a re-pointed link)
    // is both.
    let both: Vec<AgentType> = gains.intersection(&loses).copied().collect();
    for agent in both {
        gains.remove(&agent);
        loses.remove(&agent);
        plan.touches.push(agent);
    }
    let mut touches: BTreeSet<AgentType> = plan.touches.drain(..).collect();
    for step in &plan.steps {
        // A broken link's removal shows nobody anything different.
        if let Step::RemoveLink { path, .. } = step {
            if plan
                .removes
                .iter()
                .any(|r| r.kind == ChangeKind::BrokenLink && Path::new(&r.path) == path.as_path())
            {
                continue;
            }
        }
        for agent in world.ctx.readers_of_entry(step.path()) {
            if not_me(&agent) && !gains.contains(&agent) && !loses.contains(&agent) {
                touches.insert(agent);
            }
        }
    }
    plan.gains = gains.into_iter().collect();
    plan.loses = loses.into_iter().collect();
    plan.touches = touches.into_iter().collect();
}

/// Plan one operation against `world`, and lay it over the view when it can
/// be carried out.
pub(crate) fn plan_op(world: &mut World, op: &SkillOp) -> Plan {
    let mut plan = Plan::default();
    let skill = match validate(&op.skill) {
        Ok(skill) => skill,
        Err(issue) => {
            plan.issue(issue);
            return plan;
        }
    };
    if world.ctx.agent(op.agent).is_none() {
        plan.issue(SkillsIssue::new(codes::AGENT_UNSUPPORTED));
        return plan;
    }
    match op.action {
        SkillAction::Enable => plan_enable(world, op.agent, &skill, &mut plan),
        SkillAction::Disable => plan_disable(world, op.agent, &skill, &mut plan),
        SkillAction::Only => plan_only(world, op.agent, &skill, &mut plan),
        SkillAction::Refresh => {
            plan_refresh(world, op.agent, &skill, op.replace_modified, &mut plan)
        }
    }
    if plan.blocked() {
        return plan;
    }
    let mut skills = vec![skill.clone()];
    if plan_ui_legacy(world, op.agent, &skill, op.action, &mut plan) {
        skills.push(super::provenance::UI_IDS[1].to_string());
    }
    if plan.blocked() {
        return plan;
    }
    settle_effects(world, &mut plan, &skills, Some(op.agent));
    if op.action == SkillAction::Disable && !plan.loses.is_empty() {
        plan.warn(SkillsIssue::new(codes::DISABLED_TOGETHER).agents(plan.loses.clone()));
    }
    plan
}

// ─── Carrying a plan out ────────────────────────────────────────────────

enum Undo {
    Nothing,
    RemoveCreated {
        path: PathBuf,
        copy: bool,
    },
    Relink {
        path: PathBuf,
        target: Option<PathBuf>,
    },
    Unstage(StagedRemoval),
    Unswap {
        staged: StagedSwap,
        backup: Option<PathBuf>,
    },
}

#[derive(Debug, Default)]
pub(crate) struct ExecReport {
    /// The operation whose step failed (`None`: the record), and why.
    pub failed: Option<(Option<usize>, SkillsIssue)>,
    pub statuses: BTreeMap<usize, OpStatus>,
    /// Links that became copies (no link could be made).
    pub copied: BTreeSet<PathBuf>,
    pub rollback_issues: Vec<(usize, SkillsIssue)>,
    /// Directories whose content changed and stayed changed.
    pub changed_dirs: Vec<PathBuf>,
}

impl ExecReport {
    pub fn ok(&self) -> bool {
        self.failed.is_none()
    }
}

fn io_issue(code: &str, path: &Path, err: impl std::fmt::Display) -> SkillsIssue {
    SkillsIssue::new(code).path(path).detail(err.to_string())
}

/// Why a step failed, and — when it had moved something and could not put
/// it back — the `rollback_failed` issue naming what it kept.
struct StepFailure {
    issue: SkillsIssue,
    rollback: Option<SkillsIssue>,
}

impl From<SkillsIssue> for Box<StepFailure> {
    fn from(issue: SkillsIssue) -> Self {
        Box::new(StepFailure {
            issue,
            rollback: None,
        })
    }
}

/// A `rollback_failed` issue for the directory `dir`, with what was kept.
fn rollback_issue(dir: &Path, error: impl std::fmt::Display, kept: &[PathBuf]) -> SkillsIssue {
    SkillsIssue::new(codes::ROLLBACK_FAILED)
        .path(dir)
        .detail(error.to_string())
        .kept(kept)
}

fn run_step(
    world: &mut World,
    step: &Step,
) -> Result<(Undo, Option<PathBuf>, bool), Box<StepFailure>> {
    let ctx = world.ctx;
    match step {
        Step::CreateLink { path, dir, skill } => {
            // Never over anything that is there, link and copy alike.
            if fs::symlink_metadata(path).is_ok() {
                return Err(SkillsIssue::new(codes::TARGET_OCCUPIED).path(path).into());
            }
            fs::create_dir_all(dir).map_err(|e| io_issue(codes::IO_ERROR, dir, e))?;
            let source = ctx.skill_path(skill);
            let record = |mode: LinkMode, copy_hash: Option<String>| RecordEntry {
                skill: skill.clone(),
                dir: dir.to_string_lossy().into_owned(),
                path: path.to_string_lossy().into_owned(),
                mode,
                created_at: now(),
                copy_hash,
            };
            match ctx.linker.link(&source, path) {
                Ok(mode) => {
                    world.record.insert(record(mode, None));
                    Ok((
                        Undo::RemoveCreated {
                            path: path.clone(),
                            copy: false,
                        },
                        None,
                        false,
                    ))
                }
                Err(link_err) => {
                    if !ctx.linker.copy_fallback() {
                        return Err(io_issue(codes::LINK_FAILED, path, link_err).into());
                    }
                    // The attempt must have left nothing behind to copy over
                    // (an empty folder a failed junction made is cleared: the
                    // path was checked empty just before, under the lock).
                    copies::clear_failed_link_leftover(path);
                    if fs::symlink_metadata(path).is_ok() {
                        return Err(io_issue(codes::TARGET_OCCUPIED, path, link_err).into());
                    }
                    match copies::create_copy(ctx, &source, path, skill) {
                        Ok(hash) => {
                            world.record.insert(record(LinkMode::Copy, Some(hash)));
                            Ok((
                                Undo::RemoveCreated {
                                    path: path.clone(),
                                    copy: true,
                                },
                                None,
                                true,
                            ))
                        }
                        Err(copy_err) => Err(SkillsIssue::new(codes::LINK_FAILED)
                            .path(path)
                            .detail(format!("link: {link_err}; copy: {copy_err}"))
                            .into()),
                    }
                }
            }
        }
        Step::RemoveLink { path, target } => {
            ctx.fault("remove_link")
                .map_err(|e| io_issue(codes::REMOVE_FAILED, path, e))?;
            match inspect(path) {
                RawEntry::Link { .. } => {}
                RawEntry::Absent => {
                    world.record.remove(path);
                    return Ok((Undo::Nothing, None, false));
                }
                _ => {
                    return Err(SkillsIssue::new(codes::REMOVE_FAILED)
                        .path(path)
                        .detail("no longer a link")
                        .into())
                }
            }
            link::remove_entry(path).map_err(|e| io_issue(codes::REMOVE_FAILED, path, e))?;
            world.record.remove(path);
            Ok((
                Undo::Relink {
                    path: path.clone(),
                    target: target.clone(),
                },
                None,
                false,
            ))
        }
        Step::RemoveCopy { path, skill } => {
            let staged = copies::stage_removal(ctx, path, skill)
                .map_err(|e| io_issue(codes::REMOVE_FAILED, path, e))?;
            world.record.remove(path);
            let op_dir = staged.op_dir.clone();
            Ok((Undo::Unstage(staged), Some(op_dir), false))
        }
        Step::ReplaceCopy {
            path,
            skill,
            backup_as,
        } => {
            let backup = match backup_as {
                Some(label) => Some(
                    super::backups::copy_into_backups(ctx, path, skill, Some(label))
                        .map_err(|e| io_issue(codes::COPY_FAILED, path, e))?,
                ),
                None => None,
            };
            match copies::swap_in(ctx, path, skill) {
                Ok(staged) => {
                    if let Some(mut entry) = world.record.get(path).cloned() {
                        entry.copy_hash = Some(staged.new_hash.clone());
                        world.record.insert(entry);
                    }
                    let op_dir = staged.op_dir.clone();
                    Ok((Undo::Unswap { staged, backup }, Some(op_dir), false))
                }
                Err(failure) if failure.kept.is_empty() => {
                    // The old copy is back in place: its backup is a spare.
                    if let Some(backup) = backup {
                        let _ = fs::remove_dir_all(&backup);
                        super::backups::tidy(ctx, skill);
                    }
                    Err(io_issue(codes::COPY_FAILED, path, failure.error).into())
                }
                Err(failure) => {
                    // The old copy could not be put back: it stays in
                    // staging, and its backup stays too.
                    let mut kept = failure.kept;
                    kept.extend(backup);
                    Err(Box::new(StepFailure {
                        issue: io_issue(codes::COPY_FAILED, path, &failure.error),
                        rollback: Some(rollback_issue(&step.dir(), &failure.error, &kept)),
                    }))
                }
            }
        }
    }
}

/// Undo one step. A failure says what stays where it is (`kept`): what
/// the step had moved into staging, a backup it had taken.
fn undo(ctx: &SkillsCtx, undo: Undo) -> Result<(), (std::io::Error, Vec<PathBuf>)> {
    let plain = |result: std::io::Result<()>| result.map_err(|err| (err, Vec::new()));
    match undo {
        Undo::Nothing => Ok(()),
        Undo::RemoveCreated { path, copy: false } => plain(match inspect(&path) {
            RawEntry::Link { .. } => link::remove_entry(&path),
            RawEntry::Absent => Ok(()),
            _ => Err(std::io::Error::other("no longer the link Codeg made")),
        }),
        // The copy Codeg made a moment ago, of the store's skill.
        Undo::RemoveCreated { path, copy: true } => plain(fs::remove_dir_all(&path)),
        Undo::Relink { path, target } => plain(match target {
            Some(target) => link::platform_link(&target, &path).map(|_| ()),
            None => Err(std::io::Error::other("the link's target is unknown")),
        }),
        Undo::Unstage(staged) => {
            copies::unstage(ctx, staged).map_err(|failure| (failure.error, failure.kept))
        }
        Undo::Unswap { staged, backup } => match copies::unswap(ctx, staged) {
            Ok(()) => {
                // The changed copy is back in place: its backup is a spare.
                if let Some(backup) = backup {
                    let _ = fs::remove_dir_all(backup);
                }
                Ok(())
            }
            Err(failure) => {
                let mut kept = failure.kept;
                kept.extend(backup);
                Err((failure.error, kept))
            }
        },
    }
}

/// Carry out the steps of `plans` (by op index), in order. Caller holds the
/// skills lock. On success the record is saved and the staging cleared.
pub(crate) fn execute(world: &mut World, plans: &[(usize, &Plan)]) -> ExecReport {
    let record_before = world.record.clone();
    let mut report = ExecReport::default();
    let mut done: Vec<(usize, Undo, PathBuf)> = Vec::new();
    let mut commits: Vec<PathBuf> = Vec::new();
    let mut failed: Option<(Option<usize>, SkillsIssue)> = None;
    'ops: for (index, plan) in plans {
        for step in &plan.steps {
            match run_step(world, step) {
                Ok((undo, commit, copied)) => {
                    done.push((*index, undo, step.dir()));
                    if let Some(commit) = commit {
                        commits.push(commit);
                    }
                    if copied {
                        report.copied.insert(step.path().to_path_buf());
                    }
                }
                Err(failure) => {
                    if let Some(rollback) = failure.rollback {
                        // The step itself moved something it could not put
                        // back: that stays changed, and is said so.
                        report.rollback_issues.push((*index, rollback));
                        report.changed_dirs.push(step.dir());
                    }
                    failed = Some((Some(*index), failure.issue));
                    break 'ops;
                }
            }
        }
    }
    if failed.is_none() {
        let saved = world
            .ctx
            .fault("record")
            .and_then(|()| world.record.save(&world.ctx.store));
        if let Err(err) = saved {
            failed = Some((
                None,
                SkillsIssue::new(codes::RECORD_WRITE_FAILED)
                    .path(super::record::record_path(&world.ctx.store))
                    .detail(err.to_string()),
            ));
        }
    }
    let touched: BTreeSet<usize> = done.iter().map(|(index, _, _)| *index).collect();
    match failed {
        None => {
            for staged in commits {
                copies::commit(&staged);
            }
            let mut dirs: Vec<PathBuf> = done.into_iter().map(|(_, _, dir)| dir).collect();
            dirs.sort();
            dirs.dedup();
            report.changed_dirs = dirs;
            for (index, plan) in plans {
                report.statuses.insert(
                    *index,
                    if plan.steps.is_empty() {
                        OpStatus::Unchanged
                    } else {
                        OpStatus::Done
                    },
                );
            }
        }
        Some((failed_op, issue)) => {
            let mut rollback_failed: BTreeSet<usize> = BTreeSet::new();
            let mut left_changed: Vec<PathBuf> = std::mem::take(&mut report.changed_dirs);
            while let Some((index, step_undo, dir)) = done.pop() {
                if let Err((err, kept)) = undo(world.ctx, step_undo) {
                    rollback_failed.insert(index);
                    left_changed.push(dir.clone());
                    report
                        .rollback_issues
                        .push((index, rollback_issue(&dir, err, &kept)));
                }
            }
            world.record = record_before;
            if !rollback_failed.is_empty() || !left_changed.is_empty() {
                // The links that could not be put back are on disk: keep the
                // record in step with them. Copies keep the entries they had —
                // a copy that stayed in staging is put back, by its journal
                // and its entry, at the next start.
                let _ = super::record::reconcile_links(world.ctx, &mut world.record);
                let _ = world.record.save(&world.ctx.store);
            }
            left_changed.sort();
            left_changed.dedup();
            report.changed_dirs = left_changed;
            for (index, _) in plans {
                let status = if Some(*index) == failed_op {
                    OpStatus::Failed
                } else if rollback_failed.contains(index) {
                    OpStatus::RollbackFailed
                } else if touched.contains(index) {
                    OpStatus::RolledBack
                } else {
                    OpStatus::NotDone
                };
                report.statuses.insert(*index, status);
            }
            report.failed = Some((failed_op, issue));
        }
    }
    world.refresh();
    report
}

// ─── `skills_apply_links` ───────────────────────────────────────────────

fn op_result(index: usize, op: &SkillOp, plan: &Plan, status: OpStatus) -> SkillOpResult {
    SkillOpResult {
        index,
        skill: op.skill.clone(),
        agent: op.agent,
        action: op.action,
        status,
        creates: plan.creates.clone(),
        removes: plan.removes.clone(),
        moves: plan.moves.clone(),
        gains: plan.gains.clone(),
        loses: plan.loses.clone(),
        touches: plan.touches.clone(),
        ack: plan.needs_ack().then(|| action_token(op, plan)),
        issues: plan.issues.clone(),
        warnings: plan.warnings.clone(),
    }
}

fn action_name(action: SkillAction) -> &'static str {
    match action {
        SkillAction::Enable => "enable",
        SkillAction::Disable => "disable",
        SkillAction::Only => "only",
        SkillAction::Refresh => "refresh",
    }
}

fn action_token(op: &SkillOp, plan: &Plan) -> String {
    let subject = if op.replace_modified {
        format!("{}+replace_modified", op.skill.trim())
    } else {
        op.skill.trim().to_string()
    };
    plan.ack_token(&subject, Some(op.agent), action_name(op.action))
}

/// What a finished apply changed, for the event.
#[derive(Debug, Default)]
pub(crate) struct Changed {
    pub dirs: Vec<PathBuf>,
}

impl Changed {
    pub fn agents(&self, ctx: &SkillsCtx) -> Vec<AgentType> {
        let mut agents: Vec<AgentType> = self
            .dirs
            .iter()
            .filter_map(|dir| ctx.dir_info(dir))
            .flat_map(|info| info.readers.clone())
            .collect();
        agents.sort();
        agents.dedup();
        agents
    }
}

/// `skills_apply_links`. Caller holds the skills lock unless this is a
/// preflight.
pub(crate) fn apply_blocking(
    ctx: &SkillsCtx,
    request: &SkillsApplyRequest,
) -> (SkillsApplyResult, Changed) {
    apply_in(World::load(ctx), request)
}

/// A preflight of `ops` as if the store already held `pending` — a skill
/// about to be installed (Harness, before its folder is in): the same plans,
/// effects and `ack`s a run gets once the folder is there. Writes nothing,
/// takes no lock.
pub(crate) fn preflight_pending(
    ctx: &SkillsCtx,
    ops: Vec<SkillOp>,
    pending: BTreeSet<String>,
) -> SkillsApplyResult {
    let request = SkillsApplyRequest {
        ops,
        preflight: true,
    };
    apply_in(World::load_pending(ctx, pending), &request).0
}

/// [`preflight_pending`] with the entries at `absent` taken to be gone
/// already (links another call removes first — the Experts pack's, taken
/// over by a plugin): the plans, effects and `ack`s the later run gets.
pub(crate) fn preflight_without(
    ctx: &SkillsCtx,
    ops: Vec<SkillOp>,
    pending: BTreeSet<String>,
    absent: &[PathBuf],
) -> SkillsApplyResult {
    let request = SkillsApplyRequest {
        ops,
        preflight: true,
    };
    let mut world = World::load_pending(ctx, pending);
    for path in absent {
        world.set(path, Entry::Absent);
    }
    apply_in(world, &request).0
}

/// [`apply_blocking`] with `prior`'s steps carried out first, in the same
/// run: a failure anywhere puts them back too. For steps the ops do not
/// plan themselves (a plugin's removal takes the copies the user changed,
/// already backed up) and that change nothing any `ack` covers. Caller holds
/// the skills lock.
pub(crate) fn apply_after(
    ctx: &SkillsCtx,
    request: &SkillsApplyRequest,
    prior: &Plan,
) -> (SkillsApplyResult, Changed) {
    apply_in_after(World::load(ctx), request, Some(prior))
}

/// The op index [`apply_after`]'s prior steps run under.
const PRIOR: usize = usize::MAX;

fn apply_in(world: World<'_>, request: &SkillsApplyRequest) -> (SkillsApplyResult, Changed) {
    apply_in_after(world, request, None)
}

fn apply_in_after(
    mut world: World<'_>,
    request: &SkillsApplyRequest,
    prior: Option<&Plan>,
) -> (SkillsApplyResult, Changed) {
    let plans: Vec<Plan> = request
        .ops
        .iter()
        .map(|op| plan_op(&mut world, op))
        .collect();
    if request.preflight {
        let ops: Vec<SkillOpResult> = request
            .ops
            .iter()
            .zip(&plans)
            .enumerate()
            .map(|(index, (op, plan))| {
                let status = if plan.blocked() {
                    OpStatus::Blocked
                } else if plan.needs_ack() {
                    OpStatus::NeedsAck
                } else if plan.steps.is_empty() {
                    OpStatus::Unchanged
                } else {
                    OpStatus::Ready
                };
                op_result(index, op, plan, status)
            })
            .collect();
        let ok = plans.iter().all(|plan| !plan.blocked());
        return (
            SkillsApplyResult {
                outcome: ApplyOutcome::Preflight,
                ok,
                ops,
                issues: Vec::new(),
            },
            Changed::default(),
        );
    }

    if plans.iter().any(Plan::blocked) {
        let ops = request
            .ops
            .iter()
            .zip(&plans)
            .enumerate()
            .map(|(index, (op, plan))| {
                let status = if plan.blocked() {
                    OpStatus::Blocked
                } else {
                    OpStatus::NotDone
                };
                op_result(index, op, plan, status)
            })
            .collect();
        return (
            SkillsApplyResult {
                outcome: ApplyOutcome::Invalid,
                ok: false,
                ops,
                issues: Vec::new(),
            },
            Changed::default(),
        );
    }

    let mut unacknowledged = false;
    let mut ops: Vec<SkillOpResult> = Vec::with_capacity(plans.len());
    for (index, (op, plan)) in request.ops.iter().zip(&plans).enumerate() {
        let mut result = op_result(index, op, plan, OpStatus::NotDone);
        if let Some(token) = &result.ack {
            if op.ack.as_deref() != Some(token.as_str()) {
                unacknowledged = true;
                result.status = OpStatus::NeedsAck;
                result.issues.push(
                    SkillsIssue::new(if op.ack.is_some() {
                        codes::EFFECTS_CHANGED
                    } else {
                        codes::ACKNOWLEDGEMENT_REQUIRED
                    })
                    .agents(
                        plan.gains
                            .iter()
                            .chain(&plan.loses)
                            .chain(&plan.touches)
                            .copied()
                            .collect(),
                    ),
                );
            }
        }
        ops.push(result);
    }
    if unacknowledged {
        return (
            SkillsApplyResult {
                outcome: ApplyOutcome::AcknowledgementRequired,
                ok: false,
                ops,
                issues: Vec::new(),
            },
            Changed::default(),
        );
    }

    let mut indexed: Vec<(usize, &Plan)> = Vec::new();
    if let Some(prior) = prior.filter(|prior| !prior.steps.is_empty()) {
        indexed.push((PRIOR, prior));
    }
    indexed.extend(plans.iter().enumerate());
    let report = execute(&mut world, &indexed);
    for result in &mut ops {
        if let Some(status) = report.statuses.get(&result.index) {
            result.status = *status;
        }
        for create in &mut result.creates {
            if report.copied.contains(Path::new(&create.path)) {
                create.kind = ChangeKind::Copy;
                result
                    .warnings
                    .push(SkillsIssue::new(codes::COPIED).path(&create.path));
            }
        }
        if let Some((Some(failed), issue)) = &report.failed {
            if *failed == result.index {
                result.issues.push(issue.clone());
            }
        }
        for (index, issue) in &report.rollback_issues {
            if *index == result.index {
                result.issues.push(issue.clone());
            }
        }
    }
    let mut issues = Vec::new();
    match &report.failed {
        Some((None, issue)) | Some((Some(PRIOR), issue)) => issues.push(issue.clone()),
        _ => {}
    }
    issues.extend(
        report
            .rollback_issues
            .iter()
            .filter(|(index, _)| *index == PRIOR)
            .map(|(_, issue)| issue.clone()),
    );
    let ok = report.ok();
    (
        SkillsApplyResult {
            outcome: if ok {
                ApplyOutcome::Applied
            } else {
                ApplyOutcome::WriteFailed
            },
            ok,
            ops,
            issues,
        },
        Changed {
            dirs: report.changed_dirs,
        },
    )
}

// ─── `skills_repair_link` ───────────────────────────────────────────────

/// `path` as an entry of one of the agents' skill directories: the
/// directory Codeg knows (any spelling of it) joined to one plain name. A
/// path that climbs (`..`) or whose name is not one plain entry (a
/// separator, a drive `C:x`) names nothing here, so whatever it would lead
/// to is never touched.
pub(crate) fn locate_in_agent_dir<'c>(
    ctx: &'c SkillsCtx,
    path: &Path,
) -> Option<(PathBuf, &'c super::DirInfo)> {
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return None;
    }
    let name = path.file_name()?.to_str()?;
    if !super::fsio::plain_name(name) {
        return None;
    }
    let info = ctx.dir_info(path.parent()?)?;
    Some((info.path.join(name), info))
}

pub(crate) struct RepairRequest {
    pub path: PathBuf,
    pub action: RepairAction,
    pub preflight: bool,
    pub ack: Option<String>,
}

/// `skills_repair_link`. Caller holds the skills lock unless this is a
/// preflight.
pub(crate) fn repair_blocking(
    ctx: &SkillsCtx,
    request: &RepairRequest,
) -> (SkillsRepairResult, Changed) {
    let mut world = World::load(ctx);
    let mut plan = Plan::default();
    let mut new_skill: Option<String> = None;
    let located = locate_in_agent_dir(ctx, &request.path);
    let (path, dir, info) = match located {
        Some((path, info)) => (path, info.path.clone(), Some(info)),
        None => {
            plan.issue(SkillsIssue::new(codes::PATH_OUTSIDE_AGENT_DIRS).path(&request.path));
            (request.path.clone(), PathBuf::new(), None)
        }
    };
    if let Some(info) = &info {
        match world.entry(&path) {
            Entry::CodegLink {
                broken: true,
                target,
                ..
            } => match request.action {
                RepairAction::Remove => plan.remove(
                    Step::RemoveLink {
                        path: path.clone(),
                        target,
                    },
                    ChangeKind::BrokenLink,
                ),
                RepairAction::Repoint => {
                    // To the store's skill of the link's own name: a link
                    // whose name is not its skill's would show the agent a
                    // skill under the wrong name.
                    let wanted = path
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    match validate(&wanted) {
                        Err(issue) => plan.issue(issue),
                        Ok(skill) if !ctx.skill_path(&skill).is_dir() => plan.issue(
                            SkillsIssue::new(codes::SKILL_NOT_FOUND).path(ctx.skill_path(&skill)),
                        ),
                        Ok(skill) => {
                            plan.remove(
                                Step::RemoveLink {
                                    path: path.clone(),
                                    target,
                                },
                                ChangeKind::BrokenLink,
                            );
                            plan.create(
                                Step::CreateLink {
                                    path: path.clone(),
                                    dir: dir.clone(),
                                    skill: skill.clone(),
                                },
                                ChangeKind::Link,
                            );
                            // An agent never gets two, as when enabling.
                            if info.readers.len() > 1 {
                                consolidate_into_shared(&world, &info.readers, &skill, &mut plan);
                            } else if let Some(&agent) = info.readers.first() {
                                if let Some(visible) = world.visible(agent, &skill) {
                                    plan.issue(
                                        SkillsIssue::new(codes::ALREADY_VISIBLE)
                                            .path(&visible.path),
                                    );
                                }
                            }
                            new_skill = Some(skill);
                        }
                    }
                }
            },
            Entry::CodegLink { broken: false, .. } | Entry::CodegCopy { .. } => {
                plan.issue(SkillsIssue::new(codes::NOT_BROKEN).path(&path))
            }
            Entry::Absent => plan.issue(SkillsIssue::new(codes::NOT_FOUND).path(&path)),
            Entry::Owned { plugin, .. } => plan.issue(
                SkillsIssue::new(codes::PLUGIN_OWNED)
                    .path(&path)
                    .detail(plugin),
            ),
            _ => plan.issue(SkillsIssue::new(codes::NOT_CODEG_LINK).path(&path)),
        }
    }
    if !plan.blocked() {
        // In a directory of one agent's own, that agent is the one asking.
        let me = info
            .as_ref()
            .filter(|info| info.readers.len() == 1)
            .map(|info| info.readers[0]);
        let skills: Vec<String> = new_skill.iter().cloned().collect();
        settle_effects(&mut world, &mut plan, &skills, me);
    }
    let action = match request.action {
        RepairAction::Repoint => "repoint",
        RepairAction::Remove => "remove",
    };
    let token = plan.needs_ack().then(|| {
        plan.ack_token(
            &format!(
                "{}>{}",
                path.to_string_lossy(),
                new_skill.as_deref().unwrap_or("")
            ),
            None,
            action,
        )
    });
    let mut result = SkillsRepairResult {
        outcome: ApplyOutcome::Preflight,
        ok: !plan.blocked(),
        path: request.path.to_string_lossy().into_owned(),
        action: request.action,
        skill: new_skill.clone(),
        status: OpStatus::Ready,
        creates: plan.creates.clone(),
        removes: plan.removes.clone(),
        gains: plan.gains.clone(),
        loses: plan.loses.clone(),
        touches: plan.touches.clone(),
        ack: token.clone(),
        issues: plan.issues.clone(),
        warnings: plan.warnings.clone(),
    };
    if plan.blocked() {
        result.status = OpStatus::Blocked;
        if !request.preflight {
            result.outcome = ApplyOutcome::Invalid;
        }
        return (result, Changed::default());
    }
    if request.preflight {
        if token.is_some() {
            result.status = OpStatus::NeedsAck;
        }
        return (result, Changed::default());
    }
    if let Some(token) = &token {
        if request.ack.as_deref() != Some(token.as_str()) {
            result.outcome = ApplyOutcome::AcknowledgementRequired;
            result.ok = false;
            result.status = OpStatus::NeedsAck;
            result
                .issues
                .push(SkillsIssue::new(if request.ack.is_some() {
                    codes::EFFECTS_CHANGED
                } else {
                    codes::ACKNOWLEDGEMENT_REQUIRED
                }));
            return (result, Changed::default());
        }
    }
    let report = execute(&mut world, &[(0, &plan)]);
    result.status = report
        .statuses
        .get(&0)
        .copied()
        .unwrap_or(OpStatus::NotDone);
    if let Some((_, issue)) = &report.failed {
        result.issues.push(issue.clone());
    }
    for (_, issue) in &report.rollback_issues {
        result.issues.push(issue.clone());
    }
    for create in &mut result.creates {
        if report.copied.contains(Path::new(&create.path)) {
            create.kind = ChangeKind::Copy;
            result
                .warnings
                .push(SkillsIssue::new(codes::COPIED).path(&create.path));
        }
    }
    result.ok = report.ok();
    result.outcome = if result.ok {
        ApplyOutcome::Applied
    } else {
        ApplyOutcome::WriteFailed
    };
    (
        result,
        Changed {
            dirs: report.changed_dirs,
        },
    )
}
