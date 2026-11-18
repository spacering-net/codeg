//! The engine's commands. Each is a `_core` function the desktop command and
//! the web handler share (`web::handlers::skills`); `codeg-mcp` exposes none
//! of them. Results say what happened in the value; a command rejects only
//! when its blocking task could not be joined (`task_execution_failed`).
//!
//! | Command | Arguments |
//! | --- | --- |
//! | `skills_inventory` | — |
//! | `skills_apply_links` | `ops`, `preflight` |
//! | `skills_adopt` | `agent`, `skill`, `dir` |
//! | `skills_repair_link` | `path`, `action`, `preflight`, `ack` |
//! | `skills_backups` | `skill` |
//! | `skills_backup_restore` | `skill`, `name`, `id` |
//! | `skills_backup_delete` | `skill`, `name` |

use std::path::PathBuf;

use crate::app_error::AppCommandError;
use crate::models::agent::AgentType;
use crate::web::event_bridge::EventEmitter;

use super::adopt::{adopt_blocking, AdoptRequest};
use super::apply::{apply_blocking, repair_blocking, RepairRequest};
use super::model::{
    AdoptOutcome, ApplyOutcome, BackupOutcome, ChangedKind, OpStatus, RepairAction, SkillOpResult,
    SkillsAdoptResult, SkillsApplyRequest, SkillsApplyResult, SkillsBackupResult, SkillsBackups,
    SkillsInventory, SkillsRepairResult,
};
use super::{announce, SkillsCtx};

fn joined<T>(result: Result<T, tokio::task::JoinError>) -> Result<T, AppCommandError> {
    result.map_err(|e| AppCommandError::task_execution_failed(format!("skills: {e}")))
}

// ─── skills_inventory ───────────────────────────────────────────────────

pub(crate) async fn skills_inventory_in(
    ctx: SkillsCtx,
) -> Result<SkillsInventory, AppCommandError> {
    joined(tokio::task::spawn_blocking(move || super::world::inventory(&ctx)).await)
}

pub async fn skills_inventory_core() -> Result<SkillsInventory, AppCommandError> {
    skills_inventory_in(SkillsCtx::user()).await
}

// ─── skills_apply_links ─────────────────────────────────────────────────

fn busy_apply(request: &SkillsApplyRequest, issue: super::model::SkillsIssue) -> SkillsApplyResult {
    SkillsApplyResult {
        outcome: ApplyOutcome::Busy,
        ok: false,
        ops: request
            .ops
            .iter()
            .enumerate()
            .map(|(index, op)| SkillOpResult {
                index,
                skill: op.skill.clone(),
                agent: op.agent,
                action: op.action,
                status: OpStatus::NotDone,
                creates: Vec::new(),
                removes: Vec::new(),
                moves: Vec::new(),
                gains: Vec::new(),
                loses: Vec::new(),
                touches: Vec::new(),
                ack: None,
                issues: Vec::new(),
                warnings: Vec::new(),
            })
            .collect(),
        issues: vec![issue],
    }
}

pub(crate) async fn skills_apply_links_in(
    ctx: SkillsCtx,
    emitter: &EventEmitter,
    request: SkillsApplyRequest,
) -> Result<SkillsApplyResult, AppCommandError> {
    let guard = if request.preflight {
        None
    } else {
        match ctx.lock().await {
            Ok(guard) => Some(guard),
            Err(err) => return Ok(busy_apply(&request, err.issue())),
        }
    };
    let task_ctx = ctx.clone();
    let (result, changed) = joined(
        tokio::task::spawn_blocking(move || {
            // The lock goes with the work: a caller that goes away midway
            // cannot let the next writer in early.
            let _guard = guard;
            apply_blocking(&task_ctx, &request)
        })
        .await,
    )?;
    if !changed.dirs.is_empty() {
        announce(emitter, [ChangedKind::Links], changed.agents(&ctx));
    }
    Ok(result)
}

pub async fn skills_apply_links_core(
    emitter: &EventEmitter,
    request: SkillsApplyRequest,
) -> Result<SkillsApplyResult, AppCommandError> {
    skills_apply_links_in(SkillsCtx::user(), emitter, request).await
}

// ─── skills_adopt ───────────────────────────────────────────────────────

pub(crate) async fn skills_adopt_in(
    ctx: SkillsCtx,
    emitter: &EventEmitter,
    agent: AgentType,
    skill: String,
    dir: Option<String>,
) -> Result<SkillsAdoptResult, AppCommandError> {
    let request = AdoptRequest {
        agent,
        skill,
        dir: dir
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty())
            .map(PathBuf::from),
    };
    let guard = match ctx.lock().await {
        Ok(guard) => guard,
        Err(err) => {
            return Ok(SkillsAdoptResult {
                outcome: AdoptOutcome::Busy,
                ok: false,
                skill: request.skill.trim().to_string(),
                agent,
                source: None,
                store_path: None,
                link_path: None,
                mode: None,
                restored: true,
                issues: vec![err.issue()],
            })
        }
    };
    let task_ctx = ctx.clone();
    let (result, changed) = joined(
        tokio::task::spawn_blocking(move || {
            let _guard = guard;
            adopt_blocking(&task_ctx, &request)
        })
        .await,
    )?;
    if !changed.dirs.is_empty() {
        announce(
            emitter,
            [
                ChangedKind::Store,
                ChangedKind::Links,
                ChangedKind::AgentSkills,
            ],
            changed.agents(&ctx),
        );
    }
    Ok(result)
}

pub async fn skills_adopt_core(
    emitter: &EventEmitter,
    agent: AgentType,
    skill: String,
    dir: Option<String>,
) -> Result<SkillsAdoptResult, AppCommandError> {
    skills_adopt_in(SkillsCtx::user(), emitter, agent, skill, dir).await
}

// ─── skills_repair_link ─────────────────────────────────────────────────

pub(crate) async fn skills_repair_link_in(
    ctx: SkillsCtx,
    emitter: &EventEmitter,
    path: String,
    action: RepairAction,
    preflight: bool,
    ack: Option<String>,
) -> Result<SkillsRepairResult, AppCommandError> {
    let request = RepairRequest {
        path: PathBuf::from(path.trim()),
        action,
        preflight,
        ack,
    };
    let guard = if preflight {
        None
    } else {
        match ctx.lock().await {
            Ok(guard) => Some(guard),
            Err(err) => {
                return Ok(SkillsRepairResult {
                    outcome: ApplyOutcome::Busy,
                    ok: false,
                    path: request.path.to_string_lossy().into_owned(),
                    action,
                    skill: None,
                    status: OpStatus::NotDone,
                    creates: Vec::new(),
                    removes: Vec::new(),
                    gains: Vec::new(),
                    loses: Vec::new(),
                    touches: Vec::new(),
                    ack: None,
                    issues: vec![err.issue()],
                    warnings: Vec::new(),
                })
            }
        }
    };
    let task_ctx = ctx.clone();
    let (result, changed) = joined(
        tokio::task::spawn_blocking(move || {
            let _guard = guard;
            repair_blocking(&task_ctx, &request)
        })
        .await,
    )?;
    if !changed.dirs.is_empty() {
        announce(emitter, [ChangedKind::Links], changed.agents(&ctx));
    }
    Ok(result)
}

pub async fn skills_repair_link_core(
    emitter: &EventEmitter,
    path: String,
    action: RepairAction,
    preflight: bool,
    ack: Option<String>,
) -> Result<SkillsRepairResult, AppCommandError> {
    skills_repair_link_in(SkillsCtx::user(), emitter, path, action, preflight, ack).await
}

// ─── Backups ────────────────────────────────────────────────────────────

pub(crate) async fn skills_backups_in(
    ctx: SkillsCtx,
    skill: Option<String>,
) -> Result<SkillsBackups, AppCommandError> {
    let skill = skill
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    joined(tokio::task::spawn_blocking(move || super::backups::list(&ctx, skill.as_deref())).await)
}

pub async fn skills_backups_core(skill: Option<String>) -> Result<SkillsBackups, AppCommandError> {
    skills_backups_in(SkillsCtx::user(), skill).await
}

fn busy_backup(skill: &str, name: &str, issue: super::model::SkillsIssue) -> SkillsBackupResult {
    SkillsBackupResult {
        outcome: BackupOutcome::Busy,
        ok: false,
        skill: skill.to_string(),
        name: name.to_string(),
        id: None,
        path: None,
        backup_kept: true,
        issues: vec![issue],
    }
}

pub(crate) async fn skills_backup_restore_in(
    ctx: SkillsCtx,
    emitter: &EventEmitter,
    skill: String,
    name: String,
    id: String,
) -> Result<SkillsBackupResult, AppCommandError> {
    let (skill, name) = (skill.trim().to_string(), name.trim().to_string());
    let guard = match ctx.lock().await {
        Ok(guard) => guard,
        Err(err) => return Ok(busy_backup(&skill, &name, err.issue())),
    };
    let task_ctx = ctx.clone();
    let result = joined(
        tokio::task::spawn_blocking(move || {
            let _guard = guard;
            super::backups::restore_as_custom(&task_ctx, &skill, &name, &id)
        })
        .await,
    )?;
    if result.ok {
        announce(
            emitter,
            [ChangedKind::Store, ChangedKind::Backups],
            Vec::<AgentType>::new(),
        );
    }
    Ok(result)
}

pub async fn skills_backup_restore_core(
    emitter: &EventEmitter,
    skill: String,
    name: String,
    id: String,
) -> Result<SkillsBackupResult, AppCommandError> {
    skills_backup_restore_in(SkillsCtx::user(), emitter, skill, name, id).await
}

pub(crate) async fn skills_backup_delete_in(
    ctx: SkillsCtx,
    emitter: &EventEmitter,
    skill: String,
    name: String,
) -> Result<SkillsBackupResult, AppCommandError> {
    let (skill, name) = (skill.trim().to_string(), name.trim().to_string());
    let guard = match ctx.lock().await {
        Ok(guard) => guard,
        Err(err) => return Ok(busy_backup(&skill, &name, err.issue())),
    };
    let task_ctx = ctx.clone();
    let result = joined(
        tokio::task::spawn_blocking(move || {
            let _guard = guard;
            super::backups::delete(&task_ctx, &skill, &name)
        })
        .await,
    )?;
    if result.ok {
        announce(emitter, [ChangedKind::Backups], Vec::<AgentType>::new());
    }
    Ok(result)
}

pub async fn skills_backup_delete_core(
    emitter: &EventEmitter,
    skill: String,
    name: String,
) -> Result<SkillsBackupResult, AppCommandError> {
    skills_backup_delete_in(SkillsCtx::user(), emitter, skill, name).await
}

// ─── Desktop commands ───────────────────────────────────────────────────

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn skills_inventory() -> Result<SkillsInventory, AppCommandError> {
    skills_inventory_core().await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn skills_apply_links(
    ops: Vec<super::model::SkillOp>,
    preflight: Option<bool>,
    app: tauri::AppHandle,
) -> Result<SkillsApplyResult, AppCommandError> {
    let request = SkillsApplyRequest {
        ops,
        preflight: preflight.unwrap_or(false),
    };
    skills_apply_links_core(&EventEmitter::from_app(&app), request).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn skills_adopt(
    agent: AgentType,
    skill: String,
    dir: Option<String>,
    app: tauri::AppHandle,
) -> Result<SkillsAdoptResult, AppCommandError> {
    skills_adopt_core(&EventEmitter::from_app(&app), agent, skill, dir).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn skills_repair_link(
    path: String,
    action: RepairAction,
    preflight: Option<bool>,
    ack: Option<String>,
    app: tauri::AppHandle,
) -> Result<SkillsRepairResult, AppCommandError> {
    skills_repair_link_core(
        &EventEmitter::from_app(&app),
        path,
        action,
        preflight.unwrap_or(false),
        ack,
    )
    .await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn skills_backups(skill: Option<String>) -> Result<SkillsBackups, AppCommandError> {
    skills_backups_core(skill).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn skills_backup_restore(
    skill: String,
    name: String,
    id: String,
    app: tauri::AppHandle,
) -> Result<SkillsBackupResult, AppCommandError> {
    skills_backup_restore_core(&EventEmitter::from_app(&app), skill, name, id).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn skills_backup_delete(
    skill: String,
    name: String,
    app: tauri::AppHandle,
) -> Result<SkillsBackupResult, AppCommandError> {
    skills_backup_delete_core(&EventEmitter::from_app(&app), skill, name).await
}
