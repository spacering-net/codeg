//! The older packs' commands (`experts_*`, `science_*`, `officecli_skill_*`,
//! `generative_ui_*`, `custom_*`) as thin wrappers over the engine. They keep
//! their names, arguments and result shapes for one release — the settings
//! screens and older remote clients still call them — and gain what the
//! engine knows:
//!
//! - a cell is `linked_to_codeg` whenever the agent sees Codeg's link to the
//!   skill, in any directory it reads (before, only its first one counted);
//! - enabling links into the agent's own directory when it has one;
//! - an operation that would change what another agent sees is refused, with
//!   the code `acknowledgement_required`: these commands cannot ask, so that
//!   is done on the Harness page (`skills_apply_links`);
//! - a pack only links its own skills: a folder of the pack's id that the
//!   pack's manifest does not claim is someone else's (`name_taken`), and its
//!   links are left alone;
//! - every per-op result carries a stable `code` beside the English `error`.

use std::path::PathBuf;

use crate::commands::experts::{ExpertInstallStatus, ExpertLinkState, LinkOp, LinkOpResult};
use crate::models::agent::AgentType;

use super::apply::{execute, plan_op, Changed};
use super::model::{codes, CellState, SkillAction, SkillOp, SkillOrigin, SkillsIssue};
use super::world::World;
use super::SkillsCtx;

/// The old state of one cell, from the engine's.
pub(crate) fn status_for(
    world: &World,
    origin: SkillOrigin,
    id: &str,
    agent: AgentType,
) -> Option<ExpertInstallStatus> {
    let ctx = world.ctx;
    let (link_dir, _) = ctx.link_dir(agent)?;
    let cell = world.cell(agent, id);
    let owned = world.provenance.origin_of(&ctx.store, id) == Some(origin);
    let state = match cell.state {
        CellState::Linked | CellState::VisibleThrough | CellState::Copy => {
            if owned {
                ExpertLinkState::LinkedToCodeg
            } else {
                // It leads to a skill of that name that is not this pack's.
                ExpertLinkState::LinkedElsewhere
            }
        }
        CellState::LinkedElsewhere => ExpertLinkState::LinkedElsewhere,
        CellState::Blocked => ExpertLinkState::BlockedByRealDirectory,
        CellState::Broken => ExpertLinkState::Broken,
        CellState::NotLinked => ExpertLinkState::NotLinked,
    };
    let link_path = cell
        .path
        .clone()
        .map(PathBuf::from)
        .unwrap_or_else(|| link_dir.join(id));
    Some(ExpertInstallStatus {
        expert_id: id.to_string(),
        agent_type: agent,
        state,
        target_path: super::link::read_target(&link_path).map(|p| p.to_string_lossy().into_owned()),
        link_path: link_path.to_string_lossy().into_owned(),
        expected_target_path: ctx.skill_path(id).to_string_lossy().into_owned(),
        copy_mode: cell.state == CellState::Copy,
    })
}

/// Every (skill, agent) cell of a pack, in skill order then `agents` order;
/// agents without a skill directory are left out.
pub(crate) fn statuses(
    ctx: &SkillsCtx,
    origin: SkillOrigin,
    ids: &[String],
    agents: &[AgentType],
) -> Vec<ExpertInstallStatus> {
    let world = World::load(ctx);
    let mut out = Vec::with_capacity(ids.len() * agents.len());
    for id in ids {
        for &agent in agents {
            if let Some(status) = status_for(&world, origin, id, agent) {
                out.push(status);
            }
        }
    }
    out
}

fn pack_name(origin: SkillOrigin) -> &'static str {
    match origin {
        SkillOrigin::Experts => "Experts",
        SkillOrigin::Science => "Science",
        SkillOrigin::Office => "Office",
        SkillOrigin::Ui => "UI",
        SkillOrigin::Harness => "Harness",
        SkillOrigin::Custom => "Custom",
    }
}

fn list(agents: &[AgentType]) -> String {
    agents
        .iter()
        .map(|a| a.to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

/// The English line the old screens show for an issue.
pub(crate) fn message(issue: &SkillsIssue, origin: SkillOrigin, id: &str) -> String {
    let path = issue.path.clone().unwrap_or_default();
    match issue.code.as_str() {
        codes::SKILL_NOT_FOUND if origin == SkillOrigin::Office => {
            format!("skill '{id}' is not synced — run sync first")
        }
        codes::SKILL_NOT_FOUND => format!("'{id}' is not in Codeg's skill store"),
        codes::NAME_TAKEN if origin == SkillOrigin::Custom => {
            format!("'{id}' belongs to one of Codeg's skill packs, not to the custom skills")
        }
        codes::NAME_TAKEN => format!(
            "'{id}' in Codeg's skill store is not the {} pack's: a skill of your own uses the name — rename it to use the built-in one",
            pack_name(origin)
        ),
        codes::TARGET_OCCUPIED => {
            format!("a real directory already exists at '{path}' — delete or rename it first")
        }
        codes::TARGET_LINKED_ELSEWHERE => format!(
            "a different link already exists at '{path}' (points to '{}') — remove it first",
            issue.detail.clone().unwrap_or_else(|| "<unknown>".into())
        ),
        codes::TARGET_BROKEN => {
            format!("a broken link already exists at '{path}' — repair or remove it first")
        }
        codes::AGENT_UNSUPPORTED => "this agent has no skill directory".to_string(),
        _ => match &issue.detail {
            Some(detail) => format!("{}: {path}: {detail}", issue.code),
            None => format!("{}: {path}", issue.code),
        },
    }
}

fn failed(op: &LinkOp, code: &str, error: String) -> LinkOpResult {
    LinkOpResult {
        expert_id: op.expert_id.clone(),
        agent_type: op.agent_type,
        ok: false,
        status: None,
        error: Some(error),
        code: Some(code.to_string()),
    }
}

fn succeeded(op: &LinkOp, status: Option<ExpertInstallStatus>) -> LinkOpResult {
    LinkOpResult {
        expert_id: op.expert_id.clone(),
        agent_type: op.agent_type,
        ok: true,
        status,
        error: None,
        code: None,
    }
}

/// One old-style op, as the engine does it. Caller holds the skills lock.
/// Returns the result and what changed.
pub(crate) fn apply_one(
    ctx: &SkillsCtx,
    origin: SkillOrigin,
    op: &LinkOp,
) -> (LinkOpResult, Changed) {
    let id = match crate::commands::acp::validate_skill_id(&op.expert_id) {
        Ok(id) => id,
        Err(err) => {
            return (
                failed(op, codes::SKILL_INVALID, err.to_string()),
                Changed::default(),
            )
        }
    };
    let mut world = World::load(ctx);
    let owner = world.provenance.origin_of(&ctx.store, &id);
    let present = std::fs::symlink_metadata(ctx.skill_path(&id)).is_ok();
    if op.enable {
        if !present {
            let issue = SkillsIssue::new(codes::SKILL_NOT_FOUND);
            return (
                failed(op, codes::SKILL_NOT_FOUND, message(&issue, origin, &id)),
                Changed::default(),
            );
        }
        if owner != Some(origin) {
            let issue = SkillsIssue::new(codes::NAME_TAKEN);
            return (
                failed(op, codes::NAME_TAKEN, message(&issue, origin, &id)),
                Changed::default(),
            );
        }
    } else if present && owner.is_some() && owner != Some(origin) {
        // Not this pack's skill: none of its links are this pack's to take.
        return (succeeded(op, None), Changed::default());
    }
    let action = if op.enable {
        SkillAction::Enable
    } else {
        SkillAction::Disable
    };
    let plan = plan_op(
        &mut world,
        &SkillOp {
            skill: id.clone(),
            agent: op.agent_type,
            action,
            ack: None,
            replace_modified: false,
        },
    );
    if let Some(issue) = plan.issues.first() {
        return (
            failed(op, &issue.code, message(issue, origin, &id)),
            Changed::default(),
        );
    }
    if plan.needs_ack() {
        let others: Vec<AgentType> = plan
            .gains
            .iter()
            .chain(&plan.loses)
            .chain(&plan.touches)
            .copied()
            .collect();
        let dir = plan
            .steps
            .iter()
            .map(|step| step.dir())
            .find(|dir| ctx.dir_info(dir).is_some_and(|info| info.readers.len() > 1))
            .unwrap_or_default();
        let error = if op.enable {
            format!(
                "{} has no skill directory of its own: the link would go into {}, which {} also read. Turn it on from the Harness Engineering page, which asks first",
                op.agent_type,
                dir.display(),
                list(&others)
            )
        } else {
            format!(
                "the link is in {}, which {} also read: turning it off here would turn it off for them too. Do it from the Harness Engineering page, which asks first",
                dir.display(),
                list(&others)
            )
        };
        return (
            failed(op, codes::ACKNOWLEDGEMENT_REQUIRED, error),
            Changed::default(),
        );
    }
    if plan.steps.is_empty() {
        let status = op
            .enable
            .then(|| status_for(&World::load(ctx), origin, &id, op.agent_type))
            .flatten();
        return (succeeded(op, status), Changed::default());
    }
    let report = execute(&mut world, &[(0, &plan)]);
    if let Some((_, issue)) = &report.failed {
        return (
            failed(op, &issue.code, message(issue, origin, &id)),
            Changed {
                dirs: report.changed_dirs,
            },
        );
    }
    let status = op
        .enable
        .then(|| status_for(&World::load(ctx), origin, &id, op.agent_type))
        .flatten();
    (
        succeeded(op, status),
        Changed {
            dirs: report.changed_dirs,
        },
    )
}

/// A batch of old-style ops, each on its own (one failing never stops the
/// rest). Caller holds the skills lock.
pub(crate) fn apply_ops(
    ctx: &SkillsCtx,
    origin: SkillOrigin,
    ops: &[LinkOp],
    known: impl Fn(&str, bool) -> Option<String>,
) -> (Vec<LinkOpResult>, Changed) {
    let mut results = Vec::with_capacity(ops.len());
    let mut dirs: Vec<PathBuf> = Vec::new();
    for op in ops {
        if let Some(error) = known(op.expert_id.trim(), op.enable) {
            results.push(failed(op, codes::SKILL_NOT_FOUND, error));
            continue;
        }
        let (result, changed) = apply_one(ctx, origin, op);
        dirs.extend(changed.dirs);
        results.push(result);
    }
    dirs.sort();
    dirs.dedup();
    (results, Changed { dirs })
}

/// Every op of a batch failed for want of the lock.
pub(crate) fn busy(ops: &[LinkOp], error: &super::lock::SkillsLockError) -> Vec<LinkOpResult> {
    ops.iter()
        .map(|op| failed(op, error.code(), error.to_string()))
        .collect()
}

/// The directories, as paths the event names agents by.
pub(crate) fn changed_agents(ctx: &SkillsCtx, dirs: &[PathBuf]) -> Vec<AgentType> {
    Changed {
        dirs: dirs.to_vec(),
    }
    .agents(ctx)
}
