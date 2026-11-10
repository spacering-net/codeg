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
    PersonalAgentSnapshot, PersonalAgentStats, TimelineChanges, TimelineCursor, TimelinePage,
    TimelineRow,
};

/// A call that names only the assistant it is about.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BotParams {
    #[serde(default)]
    pub bot_id: Option<i32>,
}

pub async fn personal_agent_get(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<BotParams>,
) -> Result<Json<PersonalAgentSnapshot>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_get_core(&state.db, &state.data_dir, params.bot_id).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineParams {
    /// The assistant it is about; left out, the primary.
    #[serde(default)]
    pub bot_id: Option<i32>,
    #[serde(default)]
    pub before_id: Option<i32>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub since_id: Option<i32>,
}

pub async fn personal_agent_timeline(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<TimelineParams>,
) -> Result<Json<TimelinePage>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_timeline_core(&state.db, params.bot_id, params.before_id, params.limit, params.since_id)
        .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineRowsParams {
    /// The assistant it is about; left out, the primary.
    #[serde(default)]
    pub bot_id: Option<i32>,
    pub ids: Vec<i32>,
}

pub async fn personal_agent_timeline_rows(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<TimelineRowsParams>,
) -> Result<Json<Vec<TimelineRow>>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_timeline_rows_core(&state.db, params.bot_id, params.ids).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineUpdatedSinceParams {
    /// The assistant it is about; left out, the primary.
    #[serde(default)]
    pub bot_id: Option<i32>,
    #[serde(default)]
    pub since: Option<chrono::DateTime<chrono::Utc>>,
    #[serde(default)]
    pub after: Option<TimelineCursor>,
    #[serde(default)]
    pub min_id: Option<i32>,
}

pub async fn personal_agent_timeline_updated_since(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<TimelineUpdatedSinceParams>,
) -> Result<Json<TimelineChanges>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_timeline_updated_since_core(&state.db, params.bot_id, params.since, params.after, params.min_id)
        .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemsParams {
    /// The assistant it is about; left out, the primary.
    #[serde(default)]
    pub bot_id: Option<i32>,
    #[serde(default)]
    pub status: Option<String>,
}

pub async fn personal_agent_items(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ItemsParams>,
) -> Result<Json<Vec<ItemInfo>>, AppCommandError> {
    Ok(Json(pa::personal_agent_items_core(&state.db, params.bot_id, params.status).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchesParams {
    /// The assistant it is about; left out, the primary.
    #[serde(default)]
    pub bot_id: Option<i32>,
    #[serde(default)]
    pub mode: Option<DispatchMode>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub ids: Option<Vec<i32>>,
}

pub async fn personal_agent_dispatches(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<DispatchesParams>,
) -> Result<Json<Vec<DispatchInfo>>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_dispatches_core(&state.db, params.bot_id, params.mode, params.limit, params.ids)
            .await?,
    ))
}

pub async fn personal_agent_files(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<BotParams>,
) -> Result<Json<Vec<PersonalAgentFile>>, AppCommandError> {
    Ok(Json(pa::personal_agent_files_core(&state.db, &state.data_dir, params.bot_id).await?))
}

pub async fn personal_agent_outputs(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<BotParams>,
) -> Result<Json<Vec<crate::personal_agent::workdir::OutputDoc>>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_outputs_core(&state.db, &state.data_dir, params.bot_id).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputReadParams {
    #[serde(default)]
    pub bot_id: Option<i32>,
    pub path: String,
}

pub async fn personal_agent_output_read(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<OutputReadParams>,
) -> Result<Json<String>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_output_read_core(&state.db, &state.data_dir, params.bot_id, params.path)
            .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsParams {
    /// The assistant it is about; left out, the primary.
    #[serde(default)]
    pub bot_id: Option<i32>,
    #[serde(default)]
    pub days: Option<u32>,
}

pub async fn personal_agent_stats(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<StatsParams>,
) -> Result<Json<PersonalAgentStats>, AppCommandError> {
    Ok(Json(pa::personal_agent_stats_core(&state.db, params.bot_id, params.days).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveParams {
    /// The assistant it is about; left out, the primary.
    #[serde(default)]
    pub bot_id: Option<i32>,
    pub draft: PersonalAgentDraft,
}

pub async fn personal_agent_save(
    Json(params): Json<SaveParams>,
) -> Result<Json<PersonalAgentInfo>, AppCommandError> {
    Ok(Json(pa::personal_agent_save_core(params.bot_id, params.draft).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendParams {
    /// The assistant it is about; left out, the primary.
    #[serde(default)]
    pub bot_id: Option<i32>,
    pub text: String,
    #[serde(default)]
    pub blocks: Option<Vec<PromptInputBlock>>,
    #[serde(default)]
    pub reply_to: Option<i32>,
}

pub async fn personal_agent_send(
    Json(params): Json<SendParams>,
) -> Result<Json<TimelineRow>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_send_core(params.bot_id, params.text, params.blocks, params.reply_to).await?,
    ))
}

pub async fn personal_agent_cancel(
    Json(params): Json<BotParams>,
) -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_cancel_core(params.bot_id).await?;
    Ok(Json(()))
}

pub async fn personal_agent_bots(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<Vec<crate::models::personal_agent_roster::RosterEntry>>, AppCommandError> {
    Ok(Json(pa::personal_agent_bots_core(&state.db).await?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RosterActParams {
    pub bot_id: i32,
    pub act: crate::models::personal_agent_roster::RosterAct,
}

pub async fn personal_agent_roster_act(
    Json(params): Json<RosterActParams>,
) -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_roster_act_core(params.bot_id, params.act).await?;
    Ok(Json(()))
}

pub async fn personal_agent_turn_steps(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<BotParams>,
) -> Result<Json<Vec<crate::models::personal_agent_roster::StepLine>>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_turn_steps_core(&state.db, params.bot_id).await?,
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemActParams {
    #[serde(default)]
    pub bot_id: Option<i32>,
    pub item_id: i32,
    pub act: String,
}

pub async fn personal_agent_item_act(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ItemActParams>,
) -> Result<Json<crate::models::personal_agent::ItemInfo>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_item_act_core(&state.db, params.bot_id, params.item_id, params.act)
            .await?,
    ))
}

pub async fn personal_agent_executors(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<Vec<crate::models::personal_agent::ExecutorView>>, AppCommandError> {
    Ok(Json(pa::personal_agent_executors_core(&state.db).await?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatchParams {
    #[serde(default)]
    pub bot_id: Option<i32>,
    pub changes: Vec<crate::personal_agent::prefs::SettingChange>,
}

pub async fn personal_agent_settings_patch(
    Json(params): Json<SettingsPatchParams>,
) -> Result<Json<Vec<crate::personal_agent::prefs::Applied>>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_settings_patch_core(params.bot_id, params.changes).await?,
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplatesParams {
    #[serde(default)]
    pub locale: Option<String>,
}

pub async fn personal_agent_templates(
    Json(params): Json<TemplatesParams>,
) -> Result<Json<Vec<crate::models::personal_agent_bots::TemplateView>>, AppCommandError> {
    Ok(Json(pa::personal_agent_templates_core(params.locale).await?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotCreateParams {
    pub draft: crate::models::personal_agent_bots::BotCreateDraft,
}

pub async fn personal_agent_bot_create(
    Json(params): Json<BotCreateParams>,
) -> Result<Json<pa::BotMade>, AppCommandError> {
    Ok(Json(pa::personal_agent_bot_create_core(params.draft).await?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotCopyParams {
    pub bot_id: i32,
    pub name: String,
    #[serde(default)]
    pub locale: Option<String>,
}

pub async fn personal_agent_bot_copy(
    Json(params): Json<BotCopyParams>,
) -> Result<Json<pa::BotMade>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_bot_copy_core(params.bot_id, params.name, params.locale).await?,
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotIdParams {
    pub bot_id: i32,
}

pub async fn personal_agent_bot_impact(
    Json(params): Json<BotIdParams>,
) -> Result<Json<crate::models::personal_agent_bots::BotImpact>, AppCommandError> {
    Ok(Json(pa::personal_agent_bot_impact_core(params.bot_id).await?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotDeleteParams {
    pub bot_id: i32,
    #[serde(default)]
    pub options: crate::models::personal_agent_bots::BotDeleteOptions,
}

pub async fn personal_agent_bot_delete(
    Json(params): Json<BotDeleteParams>,
) -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_bot_delete_core(params.bot_id, params.options).await?;
    Ok(Json(()))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotTemplateParams {
    pub bot_id: i32,
    pub template: String,
}

pub async fn personal_agent_bot_set_template(
    Json(params): Json<BotTemplateParams>,
) -> Result<Json<TimelineRow>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_bot_set_template_core(params.bot_id, params.template).await?,
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChoiceAnswerParams {
    #[serde(default)]
    pub bot_id: Option<i32>,
    pub notice_id: i32,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub project_id: Option<i32>,
}

pub async fn personal_agent_choice_answer(
    Json(params): Json<ChoiceAnswerParams>,
) -> Result<Json<TimelineRow>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_choice_answer_core(
            params.bot_id,
            params.notice_id,
            params.key,
            params.text,
            params.project_id,
        )
        .await?,
    ))
}

pub async fn personal_agent_stop_all(
    Json(params): Json<BotParams>,
) -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_stop_all_core(params.bot_id).await?;
    Ok(Json(()))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadParams {
    #[serde(default)]
    pub bot_id: Option<i32>,
    pub thread_id: i32,
}

pub async fn personal_agent_thread(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ThreadParams>,
) -> Result<Json<crate::models::personal_agent::ThreadView>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_thread_core(&state.db, params.bot_id, params.thread_id).await?,
    ))
}

pub async fn personal_agent_compact(
    Json(params): Json<BotParams>,
) -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_compact_core(params.bot_id).await?;
    Ok(Json(()))
}

pub async fn personal_agent_new_session(
    Json(params): Json<BotParams>,
) -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_new_session_core(params.bot_id).await?;
    Ok(Json(()))
}

pub async fn personal_agent_resume_auto_compact(
    Json(params): Json<BotParams>,
) -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_resume_auto_compact_core(params.bot_id).await?;
    Ok(Json(()))
}

pub async fn personal_agent_keepalive(
    Json(params): Json<BotParams>,
) -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_keepalive_core(params.bot_id).await?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResendParams {
    /// The assistant it is about; left out, the primary.
    #[serde(default)]
    pub bot_id: Option<i32>,
    pub row_id: i32,
}

pub async fn personal_agent_resend(
    Json(params): Json<ResendParams>,
) -> Result<Json<TimelineRow>, AppCommandError> {
    Ok(Json(pa::personal_agent_resend_core(params.bot_id, params.row_id).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkSeenParams {
    /// The assistant it is about; left out, the primary.
    #[serde(default)]
    pub bot_id: Option<i32>,
    pub up_to: i32,
}

pub async fn personal_agent_mark_seen(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<MarkSeenParams>,
) -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_mark_seen_core(&state.db, params.bot_id, params.up_to).await?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoticeActParams {
    /// The assistant it is about; left out, the primary.
    #[serde(default)]
    pub bot_id: Option<i32>,
    pub notice_id: i32,
    pub action: String,
}

pub async fn personal_agent_notice_act(
    Json(params): Json<NoticeActParams>,
) -> Result<Json<TimelineRow>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_notice_act_core(params.bot_id, params.notice_id, params.action).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerQuestionParams {
    /// The assistant it is about; left out, the primary.
    #[serde(default)]
    pub bot_id: Option<i32>,
    pub question_id: String,
    pub answer: crate::acp::question::QuestionAnswer,
}

pub async fn personal_agent_answer_question(
    Json(params): Json<AnswerQuestionParams>,
) -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_answer_question_core(params.bot_id, params.question_id, params.answer).await?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerPlanParams {
    /// The assistant it is about; left out, the primary.
    #[serde(default)]
    pub bot_id: Option<i32>,
    pub approval_id: String,
    pub answer: crate::acp::plan_approval::PlanApprovalAnswer,
}

pub async fn personal_agent_answer_plan(
    Json(params): Json<AnswerPlanParams>,
) -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_answer_plan_core(params.bot_id, params.approval_id, params.answer).await?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RespondPermissionParams {
    /// The assistant it is about; left out, the primary.
    #[serde(default)]
    pub bot_id: Option<i32>,
    pub request_id: String,
    pub option_id: String,
}

pub async fn personal_agent_respond_permission(
    Json(params): Json<RespondPermissionParams>,
) -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_respond_permission_core(params.bot_id, params.request_id, params.option_id).await?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSaveParams {
    /// The assistant it is about; left out, the primary.
    #[serde(default)]
    pub bot_id: Option<i32>,
    pub name: String,
    pub content: String,
}

pub async fn personal_agent_file_save(
    Json(params): Json<FileSaveParams>,
) -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_file_save_core(params.bot_id, params.name, params.content).await?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDeleteParams {
    /// The assistant it is about; left out, the primary.
    #[serde(default)]
    pub bot_id: Option<i32>,
    pub name: String,
}

pub async fn personal_agent_file_delete(
    Json(params): Json<FileDeleteParams>,
) -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_file_delete_core(params.bot_id, params.name).await?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetWorkdirParams {
    /// The assistant it is about; left out, the primary.
    #[serde(default)]
    pub bot_id: Option<i32>,
    #[serde(default)]
    pub path: Option<String>,
    /// The UI's locale, for the template files of a directory made anew.
    #[serde(default)]
    pub locale: Option<String>,
}

pub async fn personal_agent_set_workdir(
    Json(params): Json<SetWorkdirParams>,
) -> Result<Json<PersonalAgentInfo>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_set_workdir_core(params.bot_id, params.path, params.locale).await?,
    ))
}
