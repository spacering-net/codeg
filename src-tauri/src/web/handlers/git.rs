use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::folders as folder_commands;
use crate::models::GitCredentials;

use super::folders::PathParams;

// ---------------------------------------------------------------------------
// Shared param structs
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathFileParams {
    pub path: String,
    pub file: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathBranchParams {
    pub path: String,
    pub branch_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathStashRefParams {
    pub path: String,
    pub stash_ref: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathNameParams {
    pub path: String,
    pub name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathNameUrlParams {
    pub path: String,
    pub name: String,
    pub url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathOperationParams {
    pub path: String,
    pub operation: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathFileContentParams {
    pub path: String,
    pub file: String,
    pub content: String,
}

// ---------------------------------------------------------------------------
// Migrated from folders.rs
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusParams {
    pub path: String,
    pub show_all_untracked: Option<bool>,
}

pub async fn git_status(
    Json(params): Json<GitStatusParams>,
) -> Result<Json<Vec<folder_commands::GitStatusEntry>>, AppCommandError> {
    let result = folder_commands::git_status(params.path, params.show_all_untracked).await?;
    Ok(Json(result))
}

pub async fn git_list_all_branches(
    Json(params): Json<PathParams>,
) -> Result<Json<folder_commands::GitBranchList>, AppCommandError> {
    let result = folder_commands::git_list_all_branches(params.path).await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitBranchesParams {
    pub path: String,
    pub commit: String,
}

pub async fn git_commit_branches(
    Json(params): Json<GitCommitBranchesParams>,
) -> Result<Json<Vec<String>>, AppCommandError> {
    let result = folder_commands::git_commit_branches(params.path, params.commit).await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitShowFileParams {
    pub path: String,
    pub file: String,
    pub ref_name: Option<String>,
}

pub async fn git_show_file(
    Json(params): Json<GitShowFileParams>,
) -> Result<Json<String>, AppCommandError> {
    let result = folder_commands::git_show_file(params.path, params.file, params.ref_name).await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitShowFileBase64Params {
    pub path: String,
    pub file: String,
    pub ref_name: Option<String>,
    pub max_bytes: Option<usize>,
}

pub async fn git_show_file_base64(
    Json(params): Json<GitShowFileBase64Params>,
) -> Result<Json<folder_commands::GitBlobBase64>, AppCommandError> {
    let result = folder_commands::git_show_file_base64(
        params.path,
        params.file,
        params.ref_name,
        params.max_bytes,
    )
    .await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffParams {
    pub path: String,
    pub file: Option<String>,
}

pub async fn git_diff(Json(params): Json<GitDiffParams>) -> Result<Json<String>, AppCommandError> {
    let result = folder_commands::git_diff(params.path, params.file).await?;
    Ok(Json(result))
}

pub async fn git_list_remotes(
    Json(params): Json<PathParams>,
) -> Result<Json<Vec<folder_commands::GitRemote>>, AppCommandError> {
    let result = folder_commands::git_list_remotes(params.path).await?;
    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// Migrated from version_control.rs
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLogParams {
    pub path: String,
    pub limit: Option<u32>,
    pub branch: Option<String>,
    pub remote: Option<String>,
    pub skip: Option<u32>,
    pub author: Option<String>,
    pub all_branches: Option<bool>,
    pub with_files: Option<bool>,
}

pub async fn git_log(
    Json(params): Json<GitLogParams>,
) -> Result<Json<folder_commands::GitLogResult>, AppCommandError> {
    let result = folder_commands::git_log(
        params.path,
        params.limit,
        params.branch,
        params.remote,
        params.skip,
        params.author,
        params.all_branches,
        params.with_files,
    )
    .await?;
    Ok(Json(result))
}

pub async fn git_current_user(
    Json(params): Json<PathParams>,
) -> Result<Json<Option<String>>, AppCommandError> {
    let result = folder_commands::git_current_user(params.path).await?;
    Ok(Json(result))
}

pub async fn git_commit_files(
    Json(params): Json<GitCommitBranchesParams>,
) -> Result<Json<Vec<folder_commands::GitLogFileChange>>, AppCommandError> {
    let result = folder_commands::git_commit_files(params.path, params.commit).await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSearchAuthorsParams {
    pub path: String,
    pub query: String,
    pub limit: Option<u32>,
}

pub async fn git_search_authors(
    Json(params): Json<GitSearchAuthorsParams>,
) -> Result<Json<Vec<String>>, AppCommandError> {
    let result =
        folder_commands::git_search_authors(params.path, params.query, params.limit).await?;
    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// New pure git handlers (Pattern A – direct function calls)
// ---------------------------------------------------------------------------

pub async fn git_init(Json(params): Json<PathParams>) -> Result<Json<()>, AppCommandError> {
    folder_commands::git_init(params.path).await?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStartPullMergeParams {
    pub path: String,
    pub upstream_commit: Option<String>,
}

pub async fn git_start_pull_merge(
    Json(params): Json<GitStartPullMergeParams>,
) -> Result<Json<()>, AppCommandError> {
    folder_commands::git_start_pull_merge(params.path, params.upstream_commit).await?;
    Ok(Json(()))
}

pub async fn git_has_merge_head(
    Json(params): Json<PathParams>,
) -> Result<Json<bool>, AppCommandError> {
    let result = folder_commands::git_has_merge_head(params.path).await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPushInfoParams {
    pub path: String,
    /// Target branch; omitted means the checked-out one.
    pub branch: Option<String>,
}

pub async fn git_push_info(
    Json(params): Json<GitPushInfoParams>,
) -> Result<Json<folder_commands::GitPushInfo>, AppCommandError> {
    let result = folder_commands::git_push_info(params.path, params.branch).await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitNewBranchParams {
    pub path: String,
    pub branch_name: String,
    pub start_point: Option<String>,
}

pub async fn git_new_branch(
    Json(params): Json<GitNewBranchParams>,
) -> Result<Json<()>, AppCommandError> {
    folder_commands::git_new_branch(params.path, params.branch_name, params.start_point).await?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeAddParams {
    pub path: String,
    pub branch_name: String,
    pub worktree_path: String,
    #[serde(default)]
    pub base: Option<String>,
}

pub async fn git_worktree_add(
    Json(params): Json<GitWorktreeAddParams>,
) -> Result<Json<()>, AppCommandError> {
    folder_commands::git_worktree_add(
        params.path,
        params.branch_name,
        params.worktree_path,
        params.base,
    )
    .await?;
    Ok(Json(()))
}

pub async fn git_checkout(
    Json(params): Json<PathBranchParams>,
) -> Result<Json<()>, AppCommandError> {
    folder_commands::git_checkout(params.path, params.branch_name).await?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitResetParams {
    pub path: String,
    pub commit: String,
    pub mode: String,
}

pub async fn git_reset(Json(params): Json<GitResetParams>) -> Result<Json<()>, AppCommandError> {
    folder_commands::git_reset(params.path, params.commit, params.mode).await?;
    Ok(Json(()))
}

pub async fn git_list_branches(
    Json(params): Json<PathParams>,
) -> Result<Json<Vec<String>>, AppCommandError> {
    let result = folder_commands::git_list_branches(params.path).await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStashPushParams {
    pub path: String,
    pub message: Option<String>,
    pub keep_index: bool,
}

pub async fn git_stash_push(
    Json(params): Json<GitStashPushParams>,
) -> Result<Json<String>, AppCommandError> {
    let result =
        folder_commands::git_stash_push(params.path, params.message, params.keep_index).await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStashPopParams {
    pub path: String,
    pub stash_ref: Option<String>,
}

pub async fn git_stash_pop(
    Json(params): Json<GitStashPopParams>,
) -> Result<Json<String>, AppCommandError> {
    let result = folder_commands::git_stash_pop(params.path, params.stash_ref).await?;
    Ok(Json(result))
}

pub async fn git_stash_list(
    Json(params): Json<PathParams>,
) -> Result<Json<Vec<folder_commands::GitStashEntry>>, AppCommandError> {
    let result = folder_commands::git_stash_list(params.path).await?;
    Ok(Json(result))
}

pub async fn git_stash_apply(
    Json(params): Json<PathStashRefParams>,
) -> Result<Json<String>, AppCommandError> {
    let result = folder_commands::git_stash_apply(params.path, params.stash_ref).await?;
    Ok(Json(result))
}

pub async fn git_stash_drop(
    Json(params): Json<PathStashRefParams>,
) -> Result<Json<String>, AppCommandError> {
    let result = folder_commands::git_stash_drop(params.path, params.stash_ref).await?;
    Ok(Json(result))
}

pub async fn git_stash_clear(
    Json(params): Json<PathParams>,
) -> Result<Json<String>, AppCommandError> {
    let result = folder_commands::git_stash_clear(params.path).await?;
    Ok(Json(result))
}

pub async fn git_stash_show(
    Json(params): Json<PathStashRefParams>,
) -> Result<Json<Vec<folder_commands::GitStatusEntry>>, AppCommandError> {
    let result = folder_commands::git_stash_show(params.path, params.stash_ref).await?;
    Ok(Json(result))
}

pub async fn git_is_tracked(
    Json(params): Json<PathFileParams>,
) -> Result<Json<bool>, AppCommandError> {
    let result = folder_commands::git_is_tracked(params.path, params.file).await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffWithBranchParams {
    pub path: String,
    pub branch: String,
    pub file: Option<String>,
}

pub async fn git_diff_with_branch(
    Json(params): Json<GitDiffWithBranchParams>,
) -> Result<Json<String>, AppCommandError> {
    let result =
        folder_commands::git_diff_with_branch(params.path, params.branch, params.file).await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitShowDiffParams {
    pub path: String,
    pub commit: String,
    pub file: Option<String>,
}

pub async fn git_show_diff(
    Json(params): Json<GitShowDiffParams>,
) -> Result<Json<String>, AppCommandError> {
    let result = folder_commands::git_show_diff(params.path, params.commit, params.file).await?;
    Ok(Json(result))
}

pub async fn git_rollback_file(
    Json(params): Json<PathFileParams>,
) -> Result<Json<()>, AppCommandError> {
    folder_commands::git_rollback_file(params.path, params.file).await?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitAddFilesParams {
    pub path: String,
    pub files: Vec<String>,
}

pub async fn git_add_files(
    Json(params): Json<GitAddFilesParams>,
) -> Result<Json<()>, AppCommandError> {
    folder_commands::git_add_files(params.path, params.files).await?;
    Ok(Json(()))
}

pub async fn git_add_remote(
    Json(params): Json<PathNameUrlParams>,
) -> Result<Json<()>, AppCommandError> {
    folder_commands::git_add_remote(params.path, params.name, params.url).await?;
    Ok(Json(()))
}

pub async fn git_remove_remote(
    Json(params): Json<PathNameParams>,
) -> Result<Json<()>, AppCommandError> {
    folder_commands::git_remove_remote(params.path, params.name).await?;
    Ok(Json(()))
}

pub async fn git_set_remote_url(
    Json(params): Json<PathNameUrlParams>,
) -> Result<Json<()>, AppCommandError> {
    folder_commands::git_set_remote_url(params.path, params.name, params.url).await?;
    Ok(Json(()))
}

pub async fn git_merge(
    Json(params): Json<PathBranchParams>,
) -> Result<Json<folder_commands::GitMergeResult>, AppCommandError> {
    let result = folder_commands::git_merge(params.path, params.branch_name).await?;
    Ok(Json(result))
}

pub async fn git_rebase(
    Json(params): Json<PathBranchParams>,
) -> Result<Json<folder_commands::GitRebaseResult>, AppCommandError> {
    let result = folder_commands::git_rebase(params.path, params.branch_name).await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDeleteBranchParams {
    pub path: String,
    pub branch_name: String,
    pub force: bool,
}

pub async fn git_delete_branch(
    Json(params): Json<GitDeleteBranchParams>,
) -> Result<Json<String>, AppCommandError> {
    let result =
        folder_commands::git_delete_branch(params.path, params.branch_name, params.force).await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRemoveWorktreeParams {
    pub path: String,
    pub branch_name: String,
    pub source_folder_id: i32,
    pub delete_branch: bool,
    pub force: bool,
}

pub async fn git_remove_worktree(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<GitRemoveWorktreeParams>,
) -> Result<Json<folder_commands::GitWorktreeRemoval>, AppCommandError> {
    let result = folder_commands::git_remove_worktree_core(
        &state.emitter,
        &state.db,
        params.path,
        params.branch_name,
        params.source_folder_id,
        params.delete_branch,
        params.force,
    )
    .await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDeleteRemoteBranchParams {
    pub path: String,
    pub remote: String,
    pub branch: String,
    pub credentials: Option<GitCredentials>,
}

pub async fn git_delete_remote_branch(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<GitDeleteRemoteBranchParams>,
) -> Result<Json<()>, AppCommandError> {
    let db = &state.db;
    folder_commands::git_delete_remote_branch_core(
        &params.path,
        &params.remote,
        &params.branch,
        params.credentials.as_ref(),
        db,
        &state.data_dir,
    )
    .await?;
    Ok(Json(()))
}

pub async fn git_list_conflicts(
    Json(params): Json<PathParams>,
) -> Result<Json<Vec<String>>, AppCommandError> {
    let result = folder_commands::git_list_conflicts(params.path).await?;
    Ok(Json(result))
}

pub async fn git_conflict_file_versions(
    Json(params): Json<PathFileParams>,
) -> Result<Json<folder_commands::GitConflictFileVersions>, AppCommandError> {
    let result = folder_commands::git_conflict_file_versions(params.path, params.file).await?;
    Ok(Json(result))
}

pub async fn git_resolve_conflict(
    Json(params): Json<PathFileContentParams>,
) -> Result<Json<()>, AppCommandError> {
    folder_commands::git_resolve_conflict(params.path, params.file, params.content).await?;
    Ok(Json(()))
}

pub async fn git_abort_operation(
    Json(params): Json<PathOperationParams>,
) -> Result<Json<()>, AppCommandError> {
    folder_commands::git_abort_operation(params.path, params.operation).await?;
    Ok(Json(()))
}

pub async fn git_continue_operation(
    Json(params): Json<PathOperationParams>,
) -> Result<Json<()>, AppCommandError> {
    folder_commands::git_continue_operation(params.path, params.operation).await?;
    Ok(Json(()))
}

// ---------------------------------------------------------------------------
// Remote git handlers (Pattern B – need AppHandle for DB access)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPullParams {
    pub path: String,
    pub credentials: Option<GitCredentials>,
}

pub async fn git_pull(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<GitPullParams>,
) -> Result<Json<folder_commands::GitPullResult>, AppCommandError> {
    let db = &state.db;
    let result = folder_commands::git_pull_core(
        &params.path,
        params.credentials.as_ref(),
        db,
        &state.data_dir,
    )
    .await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFetchParams {
    pub path: String,
    pub credentials: Option<GitCredentials>,
}

pub async fn git_fetch(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<GitFetchParams>,
) -> Result<Json<String>, AppCommandError> {
    let db = &state.db;
    let result = folder_commands::git_fetch_core(
        &params.path,
        params.credentials.as_ref(),
        db,
        &state.data_dir,
    )
    .await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitUpdateBranchParams {
    pub path: String,
    pub branch: String,
    pub is_remote: bool,
    pub credentials: Option<GitCredentials>,
}

pub async fn git_update_branch(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<GitUpdateBranchParams>,
) -> Result<Json<folder_commands::GitPullResult>, AppCommandError> {
    let db = &state.db;
    let result = folder_commands::git_update_branch_core(
        &params.path,
        &params.branch,
        params.is_remote,
        params.credentials.as_ref(),
        db,
        &state.data_dir,
    )
    .await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPushParams {
    pub folder_id: Option<i32>,
    pub path: String,
    pub remote: Option<String>,
    /// Target branch; omitted means the checked-out one.
    pub branch: Option<String>,
    pub credentials: Option<GitCredentials>,
}

pub async fn git_push(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<GitPushParams>,
) -> Result<Json<folder_commands::GitPushResult>, AppCommandError> {
    let db = &state.db;
    let emitter = state.emitter.clone();
    let result = folder_commands::git_push_core(
        &state.data_dir,
        &emitter,
        params.folder_id,
        &params.path,
        params.remote.as_deref(),
        params.branch.as_deref(),
        params.credentials.as_ref(),
        db,
    )
    .await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitParams {
    pub folder_id: Option<i32>,
    pub path: String,
    pub message: String,
    pub files: Vec<String>,
}

pub async fn git_commit(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<GitCommitParams>,
) -> Result<Json<folder_commands::GitCommitResult>, AppCommandError> {
    let db = &state.db;
    let emitter = state.emitter.clone();
    let result = folder_commands::git_commit_core(
        &emitter,
        params.folder_id,
        &db.conn,
        &params.path,
        &params.message,
        &params.files,
    )
    .await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFetchRemoteParams {
    pub path: String,
    pub name: String,
    pub credentials: Option<GitCredentials>,
}

pub async fn git_fetch_remote(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<GitFetchRemoteParams>,
) -> Result<Json<String>, AppCommandError> {
    let db = &state.db;
    let result = folder_commands::git_fetch_remote_core(
        &params.path,
        &params.name,
        params.credentials.as_ref(),
        db,
        &state.data_dir,
    )
    .await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneRepositoryParams {
    pub url: String,
    pub target_dir: String,
    pub credentials: Option<GitCredentials>,
}

pub async fn clone_repository(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<CloneRepositoryParams>,
) -> Result<Json<()>, AppCommandError> {
    let db = &state.db;
    folder_commands::clone_repository_core(
        &params.url,
        &params.target_dir,
        params.credentials.as_ref(),
        db,
        &state.data_dir,
    )
    .await?;
    Ok(Json(()))
}
