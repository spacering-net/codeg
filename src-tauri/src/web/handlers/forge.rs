//! Server-mode HTTP surface of the forge workbench — thin wrappers over the
//! `commands::forge` cores, same discipline as `handlers::work_task`.

use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::Extension,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::forge as core;
use crate::forge::settings::{ForgePanelSettings, ForgeSettingsStore};
use crate::forge::{
    ChangeFilesQuery, ChangeMergeRequest, ChangeQuery, CommentDraft, CommentFilters, CountFilters,
    ListFilters, NewIssueDraft, StateChangeRequest,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderParams {
    pub folder_id: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelsParams {
    pub folder_id: i32,
    #[serde(default)]
    pub account_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListIssuesParams {
    pub folder_id: i32,
    /// Everything the client gets to decide, in one value. Nested rather than
    /// flattened so the trust boundary stays visible: the repository is not in
    /// here, and cannot be.
    pub query: ListFilters,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabCountParams {
    pub folder_id: i32,
    /// Which tab to count. Always the one NOT on screen — the visible tab's
    /// count rides along with its own list response (see
    /// `forge_tab_count_core`).
    pub tab: crate::forge::ForgeTab,
    /// The filter half only — a count has no page or order (see
    /// `CountFilters`).
    pub filters: CountFilters,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListCommentsParams {
    pub folder_id: i32,
    /// Which item, and which page of its discussion. Nested for the same
    /// reason `query` is on the list: the repository is not in here, and
    /// cannot be.
    pub filters: CommentFilters,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCommentParams {
    pub folder_id: i32,
    /// The comment to post. Nested for the same reason every other forge
    /// payload is: the repository is not in here, and cannot be.
    pub draft: CommentDraft,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetItemStateParams {
    pub folder_id: i32,
    pub request: StateChangeRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateIssueParams {
    pub folder_id: i32,
    pub draft: NewIssueDraft,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeDetailParams {
    pub folder_id: i32,
    pub query: ChangeQuery,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeFilesParams {
    pub folder_id: i32,
    pub query: ChangeFilesQuery,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityParams {
    pub folder_id: i32,
    #[serde(default)]
    pub account_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeOptionsParams {
    pub folder_id: i32,
    #[serde(default)]
    pub account_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeChangeParams {
    pub folder_id: i32,
    pub request: ChangeMergeRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFromForgeParams {
    pub draft: core::ForgeTaskDraft,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupParams {
    pub source_keys: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsParams {
    /// Which scope is being written — absent (or null) is the global row.
    #[serde(default)]
    pub folder_id: Option<i32>,
    /// The scope's settings wholesale, or absent to DROP a folder's own row so
    /// it follows the global one again (see `forge::settings::save`). Its
    /// FIELDS keep their snake_case wire names: this is the same blob that goes
    /// into storage, not a request DTO built around it.
    #[serde(default)]
    pub settings: Option<ForgePanelSettings>,
}

pub async fn folder_forge_remote(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<FolderParams>,
) -> Result<Json<Option<core::ForgeRemote>>, AppCommandError> {
    Ok(Json(
        core::folder_forge_remote_core(&state.db, params.folder_id).await?,
    ))
}

pub async fn forge_list_issues(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ListIssuesParams>,
) -> Result<Json<crate::forge::ForgeIssueList>, AppCommandError> {
    Ok(Json(
        core::forge_list_issues_core(&state.db, params.folder_id, params.query).await?,
    ))
}

pub async fn forge_tab_count(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<TabCountParams>,
) -> Result<Json<Option<i64>>, AppCommandError> {
    Ok(Json(
        core::forge_tab_count_core(&state.db, params.folder_id, params.tab, params.filters).await?,
    ))
}

pub async fn forge_list_labels(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<LabelsParams>,
) -> Result<Json<crate::forge::ForgeLabelList>, AppCommandError> {
    Ok(Json(
        core::forge_list_labels_core(&state.db, params.folder_id, params.account_id).await?,
    ))
}

pub async fn forge_list_comments(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ListCommentsParams>,
) -> Result<Json<crate::forge::ForgeCommentList>, AppCommandError> {
    Ok(Json(
        core::forge_list_comments_core(&state.db, params.folder_id, params.filters).await?,
    ))
}

pub async fn forge_create_comment(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<CreateCommentParams>,
) -> Result<Json<crate::forge::ForgeComment>, AppCommandError> {
    Ok(Json(
        core::forge_create_comment_core(&state.db, params.folder_id, params.draft).await?,
    ))
}

pub async fn forge_set_item_state(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SetItemStateParams>,
) -> Result<Json<crate::forge::ForgeIssueRow>, AppCommandError> {
    Ok(Json(
        core::forge_set_item_state_core(&state.db, params.folder_id, params.request).await?,
    ))
}

pub async fn forge_create_issue(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<CreateIssueParams>,
) -> Result<Json<crate::forge::ForgeIssueRow>, AppCommandError> {
    Ok(Json(
        core::forge_create_issue_core(&state.db, params.folder_id, params.draft).await?,
    ))
}

pub async fn forge_change_detail(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ChangeDetailParams>,
) -> Result<Json<crate::forge::ForgeChangeDetail>, AppCommandError> {
    Ok(Json(
        core::forge_change_detail_core(&state.db, params.folder_id, params.query).await?,
    ))
}

pub async fn forge_change_files(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ChangeFilesParams>,
) -> Result<Json<crate::forge::ForgeChangedFileList>, AppCommandError> {
    Ok(Json(
        core::forge_change_files_core(&state.db, params.folder_id, params.query).await?,
    ))
}

pub async fn forge_identity(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<IdentityParams>,
) -> Result<Json<crate::forge::ForgeIdentity>, AppCommandError> {
    Ok(Json(
        core::forge_identity_core(&state.db, params.folder_id, params.account_id).await?,
    ))
}

pub async fn forge_merge_options(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<MergeOptionsParams>,
) -> Result<Json<crate::forge::ForgeMergeOptions>, AppCommandError> {
    Ok(Json(
        core::forge_merge_options_core(&state.db, params.folder_id, params.account_id).await?,
    ))
}

pub async fn forge_merge_change(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<MergeChangeParams>,
) -> Result<Json<Option<crate::forge::ForgeIssueRow>>, AppCommandError> {
    Ok(Json(
        core::forge_merge_change_core(&state.db, params.folder_id, params.request).await?,
    ))
}

pub async fn work_task_create_from_forge(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<CreateFromForgeParams>,
) -> Result<Json<core::ForgeCreateResult>, AppCommandError> {
    Ok(Json(
        core::work_task_create_from_forge_core(&state.emitter, &state.db, params.draft).await?,
    ))
}

pub async fn work_task_lookup_by_source(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<LookupParams>,
) -> Result<Json<Vec<core::ForgeTaskLink>>, AppCommandError> {
    Ok(Json(
        core::work_task_lookup_by_source_core(&state.db, params.source_keys).await?,
    ))
}

pub async fn forge_settings_get(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<ForgeSettingsStore>, AppCommandError> {
    Ok(Json(core::forge_settings_get_core(&state.db).await?))
}

pub async fn forge_settings_set(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SettingsParams>,
) -> Result<Json<ForgeSettingsStore>, AppCommandError> {
    Ok(Json(
        core::forge_settings_set_core(&state.db, params.folder_id, params.settings).await?,
    ))
}

pub async fn forge_auto_status(
    Json(params): Json<FolderParams>,
) -> Result<Json<crate::forge::auto::ForgeAutoStatus>, AppCommandError> {
    Ok(Json(core::forge_auto_status_core(params.folder_id).await?))
}

pub async fn forge_auto_scan_now(
    Json(params): Json<FolderParams>,
) -> Result<Json<crate::forge::auto::ScanReport>, AppCommandError> {
    Ok(Json(core::forge_auto_scan_now_core(params.folder_id).await?))
}

/// Largest webhook body accepted. Issue and pull-request deliveries are a few
/// kilobytes (a pull request's body is capped at 64k characters by GitHub);
/// this leaves a wide margin without letting an unauthenticated caller make
/// the server buffer GitHub's 25 MB push-event ceiling.
pub const WEBHOOK_BODY_LIMIT: usize = 2 * 1024 * 1024;

/// `POST /api/forge_webhook` — where a forge delivers webhooks for
/// auto-processing.
///
/// PUBLIC, because no forge can send codeg's bearer token; the delivery's own
/// signature (or GitLab's secret token) is the authentication, checked against
/// the secrets of the folders that take deliveries before anything else is
/// done with the request — see `AutoProcessor::handle_webhook`. The answer is
/// a status plus one line of JSON for the forge's delivery log, which is where
/// someone setting the webhook up looks first.
pub async fn forge_webhook(headers: HeaderMap, body: Bytes) -> Response {
    let Some(processor) = crate::forge::auto::processor() else {
        return webhook_answer(
            503,
            "auto-processing is not running in this codeg process".to_string(),
        );
    };
    let outcome = processor.handle_webhook(&headers, &body).await;
    webhook_answer(outcome.status, outcome.message)
}

fn webhook_answer(status: u16, message: String) -> Response {
    let code = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (
        code,
        Json(serde_json::json!({ "ok": code.is_success(), "message": message })),
    )
        .into_response()
}
