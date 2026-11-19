use std::sync::Arc;

use axum::{Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::custom_skills as custom_skills_commands;
use crate::commands::custom_skills::{CustomDeleteResult, CustomImportResult, CustomSkillItem};
use crate::commands::experts::{ExpertInstallStatus, LinkOp, LinkOpResult};
use crate::models::agent::AgentType;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomIdParams {
    pub id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomApplyLinksParams {
    pub ops: Vec<LinkOp>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomContentParams {
    pub id: String,
    pub content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomDuplicateParams {
    pub source_id: String,
    pub new_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomImportParams {
    pub source_path: String,
    #[serde(default)]
    pub id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomImportFromAgentParams {
    pub agent_type: AgentType,
    pub ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomDeleteParams {
    pub ids: Vec<String>,
}

pub async fn custom_list() -> Result<Json<Vec<CustomSkillItem>>, AppCommandError> {
    let result = custom_skills_commands::custom_list()
        .await
        .map_err(|e| AppCommandError::from(&e))?;
    Ok(Json(result))
}

pub async fn custom_list_all_install_statuses(
) -> Result<Json<Vec<ExpertInstallStatus>>, AppCommandError> {
    let result = custom_skills_commands::custom_list_all_install_statuses()
        .await
        .map_err(|e| AppCommandError::from(&e))?;
    Ok(Json(result))
}

pub async fn custom_apply_links(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<CustomApplyLinksParams>,
) -> Result<Json<Vec<LinkOpResult>>, AppCommandError> {
    let result = custom_skills_commands::custom_apply_links_core(&state.emitter, params.ops)
        .await
        .map_err(|e| AppCommandError::from(&e))?;
    Ok(Json(result))
}

pub async fn custom_read_skill(
    Json(params): Json<CustomIdParams>,
) -> Result<Json<String>, AppCommandError> {
    let result = custom_skills_commands::custom_read_skill(params.id)
        .await
        .map_err(|e| AppCommandError::from(&e))?;
    Ok(Json(result))
}

pub async fn custom_create_skill(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<CustomContentParams>,
) -> Result<Json<CustomSkillItem>, AppCommandError> {
    let result = custom_skills_commands::custom_create_skill_core(
        &state.emitter,
        params.id,
        params.content,
    )
    .await
    .map_err(|e| AppCommandError::from(&e))?;
    Ok(Json(result))
}

pub async fn custom_save_skill(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<CustomContentParams>,
) -> Result<Json<CustomSkillItem>, AppCommandError> {
    let result = custom_skills_commands::custom_save_skill_core(
        &state.emitter,
        params.id,
        params.content,
    )
    .await
    .map_err(|e| AppCommandError::from(&e))?;
    Ok(Json(result))
}

pub async fn custom_duplicate_skill(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<CustomDuplicateParams>,
) -> Result<Json<CustomSkillItem>, AppCommandError> {
    let result = custom_skills_commands::custom_duplicate_skill_core(
        &state.emitter,
        params.source_id,
        params.new_id,
    )
    .await
    .map_err(|e| AppCommandError::from(&e))?;
    Ok(Json(result))
}

pub async fn custom_import_skill(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<CustomImportParams>,
) -> Result<Json<CustomSkillItem>, AppCommandError> {
    let result = custom_skills_commands::custom_import_skill_core(
        &state.emitter,
        params.source_path,
        params.id,
    )
    .await
    .map_err(|e| AppCommandError::from(&e))?;
    Ok(Json(result))
}

pub async fn custom_import_from_agent(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<CustomImportFromAgentParams>,
) -> Result<Json<Vec<CustomImportResult>>, AppCommandError> {
    let result = custom_skills_commands::custom_import_from_agent_core(
        &state.emitter,
        params.agent_type,
        params.ids,
    )
    .await
    .map_err(|e| AppCommandError::from(&e))?;
    Ok(Json(result))
}

pub async fn custom_delete_skills(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<CustomDeleteParams>,
) -> Result<Json<Vec<CustomDeleteResult>>, AppCommandError> {
    let result = custom_skills_commands::custom_delete_skills_core(&state.emitter, params.ids)
        .await
        .map_err(|e| AppCommandError::from(&e))?;
    Ok(Json(result))
}
