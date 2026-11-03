use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::acp::types::PromptInputBlock;
use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::personal_agent as pa;
use crate::db::entities::personal_agent_dispatch::DispatchMode;
use crate::models::personal_agent::{
    DispatchInfo, ItemInfo, PersonalAgentDraft, PersonalAgentFile, PersonalAgentInfo,
    PersonalAgentSnapshot, PersonalAgentStats, TimelinePage, TimelineRow,
};

pub async fn personal_agent_get(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<PersonalAgentSnapshot>, AppCommandError> {
    Ok(Json(pa::personal_agent_get_core(&state.db, &state.data_dir).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineParams {
    #[serde(default)]
    pub before_id: Option<i32>,
    #[serde(default)]
    pub limit: Option<u32>,
}

pub async fn personal_agent_timeline(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<TimelineParams>,
) -> Result<Json<TimelinePage>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_timeline_core(&state.db, params.before_id, params.limit).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemsParams {
    #[serde(default)]
    pub status: Option<String>,
}

pub async fn personal_agent_items(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ItemsParams>,
) -> Result<Json<Vec<ItemInfo>>, AppCommandError> {
    Ok(Json(pa::personal_agent_items_core(&state.db, params.status).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchesParams {
    #[serde(default)]
    pub mode: Option<DispatchMode>,
    #[serde(default)]
    pub limit: Option<u32>,
}

pub async fn personal_agent_dispatches(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<DispatchesParams>,
) -> Result<Json<Vec<DispatchInfo>>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_dispatches_core(&state.db, params.mode, params.limit).await?,
    ))
}

pub async fn personal_agent_files(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<Vec<PersonalAgentFile>>, AppCommandError> {
    Ok(Json(pa::personal_agent_files_core(&state.db, &state.data_dir).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsParams {
    #[serde(default)]
    pub days: Option<u32>,
}

pub async fn personal_agent_stats(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<StatsParams>,
) -> Result<Json<PersonalAgentStats>, AppCommandError> {
    Ok(Json(pa::personal_agent_stats_core(&state.db, params.days).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveParams {
    pub draft: PersonalAgentDraft,
}

pub async fn personal_agent_save(
    Json(params): Json<SaveParams>,
) -> Result<Json<PersonalAgentInfo>, AppCommandError> {
    Ok(Json(pa::personal_agent_save_core(params.draft).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendParams {
    pub text: String,
    #[serde(default)]
    pub blocks: Option<Vec<PromptInputBlock>>,
}

pub async fn personal_agent_send(
    Json(params): Json<SendParams>,
) -> Result<Json<TimelineRow>, AppCommandError> {
    Ok(Json(pa::personal_agent_send_core(params.text, params.blocks).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupplementParams {
    pub text: String,
}

pub async fn personal_agent_supplement(
    Json(params): Json<SupplementParams>,
) -> Result<Json<pa::SupplementResult>, AppCommandError> {
    Ok(Json(pa::personal_agent_supplement_core(params.text).await?))
}

pub async fn personal_agent_cancel() -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_cancel_core().await?;
    Ok(Json(()))
}

pub async fn personal_agent_compact() -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_compact_core().await?;
    Ok(Json(()))
}

pub async fn personal_agent_new_session() -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_new_session_core().await?;
    Ok(Json(()))
}

pub async fn personal_agent_resume_auto_compact() -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_resume_auto_compact_core().await?;
    Ok(Json(()))
}

pub async fn personal_agent_keepalive() -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_keepalive_core().await?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResendParams {
    pub row_id: i32,
}

pub async fn personal_agent_resend(
    Json(params): Json<ResendParams>,
) -> Result<Json<TimelineRow>, AppCommandError> {
    Ok(Json(pa::personal_agent_resend_core(params.row_id).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerQuestionParams {
    pub question_id: String,
    pub answer: crate::acp::question::QuestionAnswer,
}

pub async fn personal_agent_answer_question(
    Json(params): Json<AnswerQuestionParams>,
) -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_answer_question_core(params.question_id, params.answer).await?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerPlanParams {
    pub approval_id: String,
    pub answer: crate::acp::plan_approval::PlanApprovalAnswer,
}

pub async fn personal_agent_answer_plan(
    Json(params): Json<AnswerPlanParams>,
) -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_answer_plan_core(params.approval_id, params.answer).await?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RespondPermissionParams {
    pub request_id: String,
    pub option_id: String,
}

pub async fn personal_agent_respond_permission(
    Json(params): Json<RespondPermissionParams>,
) -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_respond_permission_core(params.request_id, params.option_id).await?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSaveParams {
    pub name: String,
    pub content: String,
}

pub async fn personal_agent_file_save(
    Json(params): Json<FileSaveParams>,
) -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_file_save_core(params.name, params.content).await?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetWorkdirParams {
    #[serde(default)]
    pub path: Option<String>,
}

pub async fn personal_agent_set_workdir(
    Json(params): Json<SetWorkdirParams>,
) -> Result<Json<PersonalAgentInfo>, AppCommandError> {
    Ok(Json(pa::personal_agent_set_workdir_core(params.path).await?))
}
