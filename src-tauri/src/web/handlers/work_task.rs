use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::work_task as core;
use crate::models::{
    WorkTaskChangedFile, WorkTaskDraft, WorkTaskEventInfo, WorkTaskFolderSettings, WorkTaskInfo,
    WorkTaskTemplateDraft, WorkTaskTemplateInfo,
};

fn default_event_limit() -> u64 {
    500
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListParams {
    #[serde(default)]
    pub folder_id: Option<i32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdParams {
    pub id: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventsParams {
    pub task_id: i32,
    #[serde(default = "default_event_limit")]
    pub limit: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateParams {
    pub draft: WorkTaskDraft,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateParams {
    pub id: i32,
    pub draft: WorkTaskDraft,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderParams {
    pub folder_id: i32,
    pub ordered_ids: Vec<i32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteParams {
    pub id: i32,
    #[serde(default)]
    pub delete_worktree: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderParams {
    pub folder_id: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReturnParams {
    pub id: i32,
    pub feedback: String,
    /// Follow-up intent; absent → `revise` (the historical behaviour).
    #[serde(default)]
    pub intent: Option<String>,
    /// Out-of-band attachments (images, pasted bytes) as raw prompt blocks.
    /// Defaults, so an older client's body still deserializes.
    #[serde(default)]
    pub blocks: Vec<serde_json::Value>,
}

/// A restart (retry / requeue) that may carry a note for the next run. `note`
/// defaults, so a body of just `{ "id": 1 }` still deserializes.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartParams {
    pub id: i32,
    #[serde(default)]
    pub note: Option<String>,
    /// Out-of-band attachments (images, pasted bytes) as raw prompt blocks.
    #[serde(default)]
    pub blocks: Vec<serde_json::Value>,
    /// Waive the forge resurrection guard (the user confirmed re-opening a
    /// work item that already has another active task).
    #[serde(default)]
    pub allow_duplicate_source: bool,
}

/// Plan a to-do task's start. `scheduledAt` is RFC 3339; absent or null clears
/// the plan.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleParams {
    pub id: i32,
    #[serde(default)]
    pub scheduled_at: Option<String>,
}

/// A cancel that may carry the user's reason for stopping the task, and
/// whether to take the worktree along. Like `RestartParams`, both default so
/// `{ "id": 1 }` still deserializes.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelParams {
    pub id: i32,
    #[serde(default)]
    pub reason: Option<String>,
    /// Take the worktree (and its work branch) along with the stop.
    #[serde(default)]
    pub delete_worktree: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeParams {
    pub id: i32,
    /// `None` → the agent writes the commit message itself.
    #[serde(default)]
    pub message: Option<String>,
    pub delete_worktree: bool,
    /// Extra directions for the merge agent; absent from every client that
    /// predates the field, which is what `default` covers.
    #[serde(default)]
    pub instructions: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteParams {
    pub id: i32,
    pub delete_worktree: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliverPrParams {
    pub id: i32,
    /// `None` → the task title becomes the pull request title.
    #[serde(default)]
    pub pr_title: Option<String>,
    #[serde(default)]
    pub draft: bool,
    /// Take the checkout along once the delivery lands. Defaults to `false`,
    /// so a client that predates the field keeps its worktree — the harmless
    /// half of a choice nobody made.
    #[serde(default)]
    pub delete_worktree: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartAllParams {
    /// `None` = every folder holding todos.
    #[serde(default)]
    pub folder_id: Option<i32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveParams {
    pub id: i32,
    pub archived: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeferParams {
    pub id: i32,
    pub deferred: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffParams {
    pub id: i32,
    #[serde(default)]
    pub file: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSetParams {
    pub folder_id: i32,
    pub settings: WorkTaskFolderSettings,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateSaveParams {
    pub draft: WorkTaskTemplateDraft,
}

pub async fn work_task_list(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ListParams>,
) -> Result<Json<Vec<WorkTaskInfo>>, AppCommandError> {
    let result = core::work_task_list_core(&state.db, params.folder_id)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(result))
}

pub async fn work_task_get(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<IdParams>,
) -> Result<Json<WorkTaskInfo>, AppCommandError> {
    let result = core::work_task_get_core(&state.db, params.id)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(result))
}

pub async fn work_task_events(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<EventsParams>,
) -> Result<Json<Vec<WorkTaskEventInfo>>, AppCommandError> {
    let result = core::work_task_events_core(&state.db, params.task_id, params.limit)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(result))
}

pub async fn work_task_attention_count(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<u64>, AppCommandError> {
    let result = core::work_task_attention_count_core(&state.db)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(result))
}

pub async fn work_task_create(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<CreateParams>,
) -> Result<Json<WorkTaskInfo>, AppCommandError> {
    let result = core::work_task_create_core(&state.emitter, &state.db, params.draft)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(result))
}

pub async fn work_task_update(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UpdateParams>,
) -> Result<Json<WorkTaskInfo>, AppCommandError> {
    let result = core::work_task_update_core(
        &state.emitter,
        &state.db,
        &state.chat_channel_manager,
        params.id,
        params.draft,
    )
    .await
    .map_err(AppCommandError::from)?;
    Ok(Json(result))
}

pub async fn work_task_reorder(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ReorderParams>,
) -> Result<Json<()>, AppCommandError> {
    core::work_task_reorder_core(
        &state.emitter,
        &state.db,
        params.folder_id,
        params.ordered_ids,
    )
    .await
    .map_err(AppCommandError::from)?;
    Ok(Json(()))
}

pub async fn work_task_delete(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<DeleteParams>,
) -> Result<Json<()>, AppCommandError> {
    core::work_task_delete_core(&state.emitter, &state.db, params.id, params.delete_worktree)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(()))
}

pub async fn work_task_start(
    Json(params): Json<IdParams>,
) -> Result<Json<()>, AppCommandError> {
    core::work_task_start_core(params.id)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(()))
}

pub async fn work_task_start_all(
    Json(params): Json<StartAllParams>,
) -> Result<Json<u32>, AppCommandError> {
    let claimed = core::work_task_start_all_core(params.folder_id)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(claimed))
}

pub async fn work_task_retry(
    Json(params): Json<RestartParams>,
) -> Result<Json<()>, AppCommandError> {
    core::work_task_retry_core(params.id, params.note, params.blocks, params.allow_duplicate_source)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(()))
}

pub async fn work_task_requeue(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<RestartParams>,
) -> Result<Json<()>, AppCommandError> {
    core::work_task_requeue_core(
        &state.emitter,
        &state.db,
        params.id,
        params.note,
        params.blocks,
        params.allow_duplicate_source,
    )
    .await
        .map_err(AppCommandError::from)?;
    Ok(Json(()))
}

pub async fn work_task_schedule(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ScheduleParams>,
) -> Result<Json<()>, AppCommandError> {
    core::work_task_schedule_core(&state.emitter, &state.db, params.id, params.scheduled_at)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(()))
}

pub async fn work_task_return(
    Json(params): Json<ReturnParams>,
) -> Result<Json<()>, AppCommandError> {
    core::work_task_return_core(params.id, params.feedback, params.intent, params.blocks)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(()))
}

pub async fn work_task_cancel(
    Json(params): Json<CancelParams>,
) -> Result<Json<()>, AppCommandError> {
    core::work_task_cancel_core(params.id, params.reason, params.delete_worktree)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(()))
}

/// `true` = the merge was queued behind another landing of the same project
/// rather than started now.
pub async fn work_task_merge(
    Json(params): Json<MergeParams>,
) -> Result<Json<bool>, AppCommandError> {
    let queued = core::work_task_merge_core(
        params.id,
        params.message,
        params.delete_worktree,
        params.instructions,
    )
    .await
    .map_err(AppCommandError::from)?;
    Ok(Json(queued))
}

pub async fn work_task_merge_unqueue(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<IdParams>,
) -> Result<Json<()>, AppCommandError> {
    core::work_task_merge_unqueue_core(&state.emitter, &state.db, params.id)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(()))
}

/// Returns the pull request URL. Awaits the whole delivery, so an error here
/// is the real reason it failed — the task is already back in review by then.
pub async fn work_task_deliver_pr(
    Json(params): Json<DeliverPrParams>,
) -> Result<Json<String>, AppCommandError> {
    let url = core::work_task_deliver_pr_core(
        params.id,
        params.pr_title,
        params.draft,
        params.delete_worktree,
    )
    .await
    .map_err(AppCommandError::from)?;
    Ok(Json(url))
}

pub async fn work_task_complete(
    Json(params): Json<CompleteParams>,
) -> Result<Json<()>, AppCommandError> {
    core::work_task_complete_core(params.id, params.delete_worktree)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(()))
}

pub async fn work_task_archive(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ArchiveParams>,
) -> Result<Json<()>, AppCommandError> {
    core::work_task_archive_core(&state.emitter, &state.db, params.id, params.archived)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(()))
}

pub async fn work_task_defer(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<DeferParams>,
) -> Result<Json<()>, AppCommandError> {
    core::work_task_defer_core(&state.emitter, &state.db, params.id, params.deferred)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(()))
}

pub async fn work_task_cleanup(
    Json(params): Json<IdParams>,
) -> Result<Json<()>, AppCommandError> {
    core::work_task_cleanup_core(params.id)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(()))
}

pub async fn work_task_diff(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<DiffParams>,
) -> Result<Json<String>, AppCommandError> {
    let result = core::work_task_diff_core(&state.db, params.id, params.file).await?;
    Ok(Json(result))
}

pub async fn work_task_changed_files(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<IdParams>,
) -> Result<Json<Vec<WorkTaskChangedFile>>, AppCommandError> {
    let result = core::work_task_changed_files_core(&state.db, params.id).await?;
    Ok(Json(result))
}

pub async fn work_task_settings_get(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<FolderParams>,
) -> Result<Json<WorkTaskFolderSettings>, AppCommandError> {
    let result = core::work_task_settings_get_core(&state.db, params.folder_id)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(result))
}

pub async fn work_task_settings_effective(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<FolderParams>,
) -> Result<Json<WorkTaskFolderSettings>, AppCommandError> {
    let result = core::work_task_settings_effective_core(&state.db, params.folder_id)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(result))
}

pub async fn work_task_settings_get_own(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<FolderParams>,
) -> Result<Json<Option<WorkTaskFolderSettings>>, AppCommandError> {
    let result = core::work_task_settings_get_own_core(&state.db, params.folder_id)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(result))
}

pub async fn work_task_settings_set(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SettingsSetParams>,
) -> Result<Json<()>, AppCommandError> {
    core::work_task_settings_set_core(
        &state.emitter,
        &state.db,
        params.folder_id,
        params.settings,
    )
    .await
    .map_err(AppCommandError::from)?;
    Ok(Json(()))
}

pub async fn work_task_settings_delete(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<FolderParams>,
) -> Result<Json<()>, AppCommandError> {
    core::work_task_settings_delete_core(&state.emitter, &state.db, params.folder_id)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(()))
}

pub async fn work_task_template_list(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<Vec<WorkTaskTemplateInfo>>, AppCommandError> {
    let result = core::work_task_template_list_core(&state.db)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(result))
}

pub async fn work_task_template_save(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<TemplateSaveParams>,
) -> Result<Json<WorkTaskTemplateInfo>, AppCommandError> {
    let result = core::work_task_template_save_core(&state.db, params.draft)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(result))
}

pub async fn work_task_template_delete(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<IdParams>,
) -> Result<Json<()>, AppCommandError> {
    core::work_task_template_delete_core(&state.db, params.id)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(()))
}
