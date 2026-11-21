//! HTTP handlers for the skills engine's commands (`crate::skills::commands`),
//! named and shaped as the desktop commands take them: `POST /api/<command>`
//! with the same argument names in a JSON body.

use std::sync::Arc;

use axum::{Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::models::agent::AgentType;
use crate::skills::commands as skills;
use crate::skills::model::{
    RepairAction, SkillOp, SkillsAdoptResult, SkillsApplyRequest, SkillsApplyResult,
    SkillsBackupResult, SkillsBackups, SkillsInventory, SkillsRepairResult,
};

pub async fn skills_inventory() -> Result<Json<SkillsInventory>, AppCommandError> {
    Ok(Json(skills::skills_inventory_core().await?))
}

#[derive(Deserialize)]
pub struct ApplyParams {
    pub ops: Vec<SkillOp>,
    #[serde(default)]
    pub preflight: Option<bool>,
}

pub async fn skills_apply_links(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ApplyParams>,
) -> Result<Json<SkillsApplyResult>, AppCommandError> {
    let request = SkillsApplyRequest {
        ops: params.ops,
        preflight: params.preflight.unwrap_or(false),
    };
    Ok(Json(
        skills::skills_apply_links_core(&state.emitter, request).await?,
    ))
}

#[derive(Deserialize)]
pub struct AdoptParams {
    pub agent: AgentType,
    pub skill: String,
    #[serde(default)]
    pub dir: Option<String>,
}

pub async fn skills_adopt(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<AdoptParams>,
) -> Result<Json<SkillsAdoptResult>, AppCommandError> {
    Ok(Json(
        skills::skills_adopt_core(&state.emitter, params.agent, params.skill, params.dir).await?,
    ))
}

#[derive(Deserialize)]
pub struct RepairParams {
    pub path: String,
    pub action: RepairAction,
    #[serde(default)]
    pub preflight: Option<bool>,
    #[serde(default)]
    pub ack: Option<String>,
}

pub async fn skills_repair_link(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<RepairParams>,
) -> Result<Json<SkillsRepairResult>, AppCommandError> {
    Ok(Json(
        skills::skills_repair_link_core(
            &state.emitter,
            params.path,
            params.action,
            params.preflight.unwrap_or(false),
            params.ack,
        )
        .await?,
    ))
}

#[derive(Deserialize, Default)]
pub struct BackupsParams {
    #[serde(default)]
    pub skill: Option<String>,
}

pub async fn skills_backups(
    Json(params): Json<BackupsParams>,
) -> Result<Json<SkillsBackups>, AppCommandError> {
    Ok(Json(skills::skills_backups_core(params.skill).await?))
}

#[derive(Deserialize)]
pub struct BackupRestoreParams {
    pub skill: String,
    pub name: String,
    pub id: String,
}

pub async fn skills_backup_restore(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<BackupRestoreParams>,
) -> Result<Json<SkillsBackupResult>, AppCommandError> {
    Ok(Json(
        skills::skills_backup_restore_core(&state.emitter, params.skill, params.name, params.id)
            .await?,
    ))
}

#[derive(Deserialize)]
pub struct BackupDeleteParams {
    pub skill: String,
    pub name: String,
}

pub async fn skills_backup_delete(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<BackupDeleteParams>,
) -> Result<Json<SkillsBackupResult>, AppCommandError> {
    Ok(Json(
        skills::skills_backup_delete_core(&state.emitter, params.skill, params.name).await?,
    ))
}
