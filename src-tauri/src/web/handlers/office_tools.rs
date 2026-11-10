use std::sync::Arc;

use axum::{Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::experts::{ExpertInstallStatus, LinkOp, LinkOpResult};
use crate::commands::office_tools as ot;
use crate::commands::office_tools::{OfficecliInfo, OfficecliSkill, SkillSyncReport};
use crate::models::agent::AgentType;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillIdParams {
    pub skill_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillAgentParams {
    pub skill_id: String,
    pub agent_type: AgentType,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderHtmlParams {
    pub root_path: String,
    pub path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyLinksParams {
    pub ops: Vec<LinkOp>,
}

pub async fn officecli_detect() -> Result<Json<OfficecliInfo>, AppCommandError> {
    let result = ot::officecli_detect().await;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficecliInstallParams {
    pub task_id: String,
}

pub async fn officecli_install(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<OfficecliInstallParams>,
) -> Result<Json<OfficecliInfo>, AppCommandError> {
    let emitter = state.emitter.clone();
    let result = ot::officecli_install_core(params.task_id, &emitter)
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?;
    Ok(Json(result))
}

pub async fn officecli_uninstall() -> Result<Json<OfficecliInfo>, AppCommandError> {
    let result = ot::officecli_uninstall()
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?;
    Ok(Json(result))
}

pub async fn officecli_list_skills() -> Result<Json<Vec<OfficecliSkill>>, AppCommandError> {
    let result = ot::officecli_list_skills().await;
    Ok(Json(result))
}

pub async fn officecli_sync_skills() -> Result<Json<SkillSyncReport>, AppCommandError> {
    let result = ot::officecli_sync_skills()
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?;
    Ok(Json(result))
}

pub async fn officecli_skill_link_to_agent(
    Json(params): Json<SkillAgentParams>,
) -> Result<Json<ExpertInstallStatus>, AppCommandError> {
    let result = ot::officecli_skill_link_to_agent(params.skill_id, params.agent_type)
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?;
    Ok(Json(result))
}

pub async fn officecli_skill_unlink_from_agent(
    Json(params): Json<SkillAgentParams>,
) -> Result<Json<()>, AppCommandError> {
    ot::officecli_skill_unlink_from_agent(params.skill_id, params.agent_type)
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?;
    Ok(Json(()))
}

pub async fn officecli_skill_get_install_status(
    Json(params): Json<SkillIdParams>,
) -> Result<Json<Vec<ExpertInstallStatus>>, AppCommandError> {
    let result = ot::officecli_skill_get_install_status(params.skill_id)
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?;
    Ok(Json(result))
}

pub async fn officecli_skill_list_all_install_statuses(
) -> Result<Json<Vec<ExpertInstallStatus>>, AppCommandError> {
    let result = ot::officecli_skill_list_all_install_statuses()
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?;
    Ok(Json(result))
}

pub async fn officecli_skill_apply_links(
    Json(params): Json<ApplyLinksParams>,
) -> Result<Json<Vec<LinkOpResult>>, AppCommandError> {
    let result = ot::officecli_skill_apply_links(params.ops)
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?;
    Ok(Json(result))
}

pub async fn officecli_skill_read_content(
    Json(params): Json<SkillIdParams>,
) -> Result<Json<String>, AppCommandError> {
    let result = ot::officecli_skill_read_content(params.skill_id)
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?;
    Ok(Json(result))
}

pub async fn officecli_render_html(
    Json(params): Json<RenderHtmlParams>,
) -> Result<Json<String>, AppCommandError> {
    let result = ot::officecli_render_html(params.root_path, params.path)
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeWatchParams {
    pub root_path: String,
    pub path: String,
    /// The watch a release names (what its start returned). Absent from a
    /// start, and from a release an older client sends.
    #[serde(default)]
    pub cap: Option<String>,
    /// The page's hold a release names (what its start returned). Absent as
    /// `cap` is.
    #[serde(default)]
    pub hold: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenewOfficeWatchParams {
    pub root_path: String,
    pub path: String,
    pub cap: String,
    /// The page's hold to renew (what its start returned).
    #[serde(default)]
    pub hold: Option<String>,
}

// Everything reaching these is a web page's: its references lapse once the
// page goes quiet (see "Who holds a watch" in `crate::office_watch`).

pub async fn start_office_watch(
    Json(params): Json<OfficeWatchParams>,
) -> Result<Json<crate::office_watch::OfficeWatchStarted>, AppCommandError> {
    // `?` converts WatchError → AppCommandError, carrying the machine code.
    let result = crate::office_watch::start_office_watch_core(
        params.root_path,
        params.path,
        crate::office_watch::WatchHolder::Web,
    )
    .await?;
    Ok(Json(result))
}

pub async fn stop_office_watch(
    Json(params): Json<OfficeWatchParams>,
) -> Result<Json<()>, AppCommandError> {
    crate::office_watch::stop_office_watch_core(
        params.root_path,
        params.path,
        params.cap,
        params.hold,
        crate::office_watch::WatchHolder::Web,
    )
    .await?;
    Ok(Json(()))
}

pub async fn renew_office_watch(
    Json(params): Json<RenewOfficeWatchParams>,
) -> Result<Json<bool>, AppCommandError> {
    Ok(Json(crate::office_watch::renew_office_watch_core(
        &params.root_path,
        &params.path,
        &params.cap,
        params.hold.as_deref(),
        crate::office_watch::WatchHolder::Web,
    )))
}
