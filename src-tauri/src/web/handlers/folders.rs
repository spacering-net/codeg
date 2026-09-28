use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::{Deserialize, Serialize};

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::folders as folder_commands;
use crate::models::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderIdParams {
    pub folder_id: i32,
}

pub async fn load_folder_history(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<Vec<FolderHistoryEntry>>, AppCommandError> {
    Ok(Json(
        folder_commands::load_folder_history_core(&state.db).await?,
    ))
}

pub async fn list_open_folders(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<Vec<FolderHistoryEntry>>, AppCommandError> {
    Ok(Json(
        folder_commands::list_open_folders_core(&state.db).await?,
    ))
}

pub async fn get_folder(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<FolderIdParams>,
) -> Result<Json<FolderDetail>, AppCommandError> {
    Ok(Json(
        folder_commands::get_folder_core(&state.db, params.folder_id).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddFolderParams {
    pub path: String,
}

/// Add the folder to the workspace (upsert + set is_open=true) and return its full detail.
/// Previously this spawned a new window; the new single-window workspace model
/// simply returns the folder info so the client can update its local state.
pub async fn open_folder(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<AddFolderParams>,
) -> Result<Json<FolderDetail>, AppCommandError> {
    Ok(Json(
        folder_commands::open_folder_core(&state.db, params.path).await?,
    ))
}

/// Launch Visual Studio Code against a file or directory on this host.
pub async fn open_in_code(
    Json(params): Json<AddFolderParams>,
) -> Result<Json<()>, AppCommandError> {
    crate::commands::open_in::open_in_code_core(params.path).await?;
    Ok(Json(()))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenWorktreeFolderParams {
    pub path: String,
    pub source_folder_id: i32,
}

/// Open a freshly created worktree directory as a folder, recording the root
/// folder it descends from. See `open_worktree_folder_core`.
pub async fn open_worktree_folder(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<OpenWorktreeFolderParams>,
) -> Result<Json<FolderDetail>, AppCommandError> {
    Ok(Json(
        folder_commands::open_worktree_folder_core(
            &state.db,
            params.path,
            params.source_folder_id,
        )
        .await?,
    ))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveWorktreeFolderParams {
    pub repo_path: String,
    pub branch: String,
}

/// Resolve where a branch is checked out (worktree path + owning folder).
/// See `resolve_worktree_folder_core`.
pub async fn resolve_worktree_folder(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ResolveWorktreeFolderParams>,
) -> Result<Json<folder_commands::WorktreeResolution>, AppCommandError> {
    Ok(Json(
        folder_commands::resolve_worktree_folder_core(&state.db, params.repo_path, params.branch)
            .await?,
    ))
}

/// Open a folder into the workspace and broadcast it to workspace clients so
/// the (separate) launcher tab's handoff lands. See
/// `open_folder_in_workspace_core`.
pub async fn open_folder_in_workspace(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<AddFolderParams>,
) -> Result<Json<FolderDetail>, AppCommandError> {
    let emitter = state.emitter.clone();
    Ok(Json(
        folder_commands::open_folder_in_workspace_core(&emitter, &state.db, params.path).await?,
    ))
}

// --- New workspace handlers ---

pub async fn list_open_folder_details(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<Vec<FolderDetail>>, AppCommandError> {
    Ok(Json(
        folder_commands::list_open_folder_details_core(&state.db).await?,
    ))
}

pub async fn list_all_folder_details(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<Vec<FolderDetail>>, AppCommandError> {
    Ok(Json(
        folder_commands::list_all_folder_details_core(&state.db).await?,
    ))
}

pub async fn open_folder_by_id(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<FolderIdParams>,
) -> Result<Json<FolderDetail>, AppCommandError> {
    Ok(Json(
        folder_commands::open_folder_by_id_core(&state.db, params.folder_id).await?,
    ))
}

pub async fn remove_folder_from_workspace(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<FolderIdParams>,
) -> Result<Json<()>, AppCommandError> {
    folder_commands::remove_folder_from_workspace_core(
        &state.emitter,
        &state.db,
        params.folder_id,
    )
    .await?;
    Ok(Json(()))
}

pub async fn list_folder_groups(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<Vec<FolderGroupDetail>>, AppCommandError> {
    Ok(Json(
        folder_commands::list_folder_groups_core(&state.db).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFolderGroupParams {
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
}

pub async fn create_folder_group(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<CreateFolderGroupParams>,
) -> Result<Json<FolderGroupDetail>, AppCommandError> {
    Ok(Json(
        folder_commands::create_folder_group_core(
            &state.emitter,
            &state.db,
            params.name,
            params.color,
        )
        .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateFolderGroupParams {
    pub group_id: i32,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
}

pub async fn update_folder_group(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UpdateFolderGroupParams>,
) -> Result<Json<FolderGroupDetail>, AppCommandError> {
    Ok(Json(
        folder_commands::update_folder_group_core(
            &state.emitter,
            &state.db,
            params.group_id,
            params.name,
            params.color,
        )
        .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderGroupIdParams {
    pub group_id: i32,
}

pub async fn delete_folder_group(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<FolderGroupIdParams>,
) -> Result<Json<()>, AppCommandError> {
    folder_commands::delete_folder_group_core(&state.emitter, &state.db, params.group_id).await?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplySidebarLayoutParams {
    pub entries: Vec<SidebarLayoutEntry>,
}

pub async fn apply_sidebar_layout(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ApplySidebarLayoutParams>,
) -> Result<Json<()>, AppCommandError> {
    folder_commands::apply_sidebar_layout_core(&state.emitter, &state.db, params.entries).await?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetFolderGroupParams {
    pub folder_id: i32,
    #[serde(default)]
    pub group_id: Option<i32>,
}

pub async fn set_folder_group(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SetFolderGroupParams>,
) -> Result<Json<()>, AppCommandError> {
    folder_commands::set_folder_group_core(
        &state.emitter,
        &state.db,
        params.folder_id,
        params.group_id,
    )
    .await?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateFolderColorParams {
    pub folder_id: i32,
    pub color: String,
}

pub async fn update_folder_color(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UpdateFolderColorParams>,
) -> Result<Json<FolderDetail>, AppCommandError> {
    Ok(Json(
        folder_commands::update_folder_color_core(&state.db, params.folder_id, params.color)
            .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateFolderAliasParams {
    pub folder_id: i32,
    pub alias: Option<String>,
}

pub async fn update_folder_alias(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UpdateFolderAliasParams>,
) -> Result<Json<FolderDetail>, AppCommandError> {
    Ok(Json(
        folder_commands::update_folder_alias_core(&state.db, params.folder_id, params.alias)
            .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateFolderDefaultAgentParams {
    pub folder_id: i32,
    pub default_agent_type: Option<AgentType>,
}

pub async fn update_folder_default_agent(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UpdateFolderDefaultAgentParams>,
) -> Result<Json<FolderDetail>, AppCommandError> {
    Ok(Json(
        folder_commands::update_folder_default_agent_core(
            &state.emitter,
            &state.db,
            params.folder_id,
            params.default_agent_type,
        )
        .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathParams {
    pub path: String,
}

pub async fn get_git_branch(
    Json(params): Json<PathParams>,
) -> Result<Json<Option<String>>, AppCommandError> {
    let result = folder_commands::get_git_branch(params.path).await?;
    Ok(Json(result))
}

pub async fn get_git_head(
    Json(params): Json<PathParams>,
) -> Result<Json<folder_commands::GitHeadInfo>, AppCommandError> {
    let result = folder_commands::get_git_head(params.path).await?;
    Ok(Json(result))
}

pub async fn get_home_directory() -> Result<Json<String>, AppCommandError> {
    let result = folder_commands::get_home_directory().await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListDirectoryEntriesParams {
    pub path: String,
}

pub async fn list_directory_entries(
    Json(params): Json<ListDirectoryEntriesParams>,
) -> Result<Json<Vec<folder_commands::DirectoryEntry>>, AppCommandError> {
    let result = folder_commands::list_directory_entries(params.path).await?;
    Ok(Json(result))
}

pub async fn list_directory_with_files(
    Json(params): Json<ListDirectoryEntriesParams>,
) -> Result<Json<Vec<folder_commands::DirectoryItem>>, AppCommandError> {
    let result = folder_commands::list_directory_with_files(params.path).await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetFileTreeParams {
    pub path: String,
    pub max_depth: Option<usize>,
}

pub async fn get_file_tree(
    Json(params): Json<GetFileTreeParams>,
) -> Result<Json<Vec<folder_commands::FileTreeNode>>, AppCommandError> {
    let result = folder_commands::get_file_tree(params.path, params.max_depth).await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListWorkspaceFilesParams {
    pub path: String,
}

pub async fn list_workspace_files(
    Json(params): Json<ListWorkspaceFilesParams>,
) -> Result<Json<Vec<folder_commands::WorkspaceFileEntry>>, AppCommandError> {
    let result = folder_commands::list_workspace_files(params.path).await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSettingsWindowParams {
    pub section: Option<String>,
    pub agent_type: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsNavigationResult {
    pub path: String,
}

/// Web equivalent of `open_settings_window`: returns the target navigation path.
/// The web client handles the actual navigation.
pub async fn open_settings_window(
    Json(params): Json<OpenSettingsWindowParams>,
) -> Result<Json<SettingsNavigationResult>, AppCommandError> {
    let route = match params.section.as_deref() {
        Some("appearance") => "settings/appearance",
        Some("agents") => "settings/agents",
        Some("mcp") => "settings/mcp",
        Some("skills") => "settings/skills",
        Some("experts") => "settings/experts",
        Some("science") => "settings/science",
        Some("office-tools") => "settings/office-tools",
        Some("collaboration") => "settings/collaboration",
        Some("browser") => "settings/browser",
        Some("version-control") => "settings/version-control",
        Some("shortcuts") => "settings/shortcuts",
        Some("system") => "settings/system",
        _ => "settings/appearance",
    };

    let path = if route == "settings/agents" {
        if let Some(ref agent) = params.agent_type {
            let trimmed = agent.trim();
            if !trimmed.is_empty()
                && trimmed
                    .chars()
                    .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_')
            {
                format!("/{route}?agent={trimmed}")
            } else {
                format!("/{route}")
            }
        } else {
            format!("/{route}")
        }
    } else {
        format!("/{route}")
    };

    Ok(Json(SettingsNavigationResult { path }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCommitWindowParams {
    pub folder_id: i32,
}

/// Web equivalent of `open_commit_window`: returns the navigation path.
pub async fn open_commit_window(
    Json(params): Json<OpenCommitWindowParams>,
) -> Result<Json<SettingsNavigationResult>, AppCommandError> {
    Ok(Json(SettingsNavigationResult {
        path: format!("/commit?folderId={}", params.folder_id),
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenMergeWindowParams {
    pub folder_id: i32,
    pub operation: Option<String>,
    pub upstream_commit: Option<String>,
}

pub async fn open_merge_window(
    Json(params): Json<OpenMergeWindowParams>,
) -> Result<Json<SettingsNavigationResult>, AppCommandError> {
    let mut path = format!("/merge?folderId={}", params.folder_id);
    if let Some(op) = &params.operation {
        path.push_str(&format!("&operation={op}"));
    }
    if let Some(uc) = &params.upstream_commit {
        path.push_str(&format!("&upstreamCommit={uc}"));
    }
    Ok(Json(SettingsNavigationResult { path }))
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OpenImportSessionsWindowParams {
    pub focus_path: Option<String>,
}

/// Web equivalent of `open_import_sessions_window`: returns the navigation
/// path; the web client opens it in a new browser window.
pub async fn open_import_sessions_window(
    Json(params): Json<OpenImportSessionsWindowParams>,
) -> Result<Json<SettingsNavigationResult>, AppCommandError> {
    let mut path = "/import-sessions".to_string();
    if let Some(focus) = params
        .focus_path
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        path.push_str(&format!("?focusPath={}", urlencoding::encode(focus)));
    }
    Ok(Json(SettingsNavigationResult { path }))
}

pub async fn open_stash_window(
    Json(params): Json<OpenCommitWindowParams>,
) -> Result<Json<SettingsNavigationResult>, AppCommandError> {
    Ok(Json(SettingsNavigationResult {
        path: format!("/stash?folderId={}", params.folder_id),
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPushWindowParams {
    pub folder_id: i32,
    /// Branch to push; omitted targets the checked-out one.
    pub branch: Option<String>,
}

pub async fn open_push_window(
    Json(params): Json<OpenPushWindowParams>,
) -> Result<Json<SettingsNavigationResult>, AppCommandError> {
    // Branch names carry `/` (and may carry `#`/`?`), so they have to be encoded
    // before riding a query string.
    let branch_param = params
        .branch
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("&branch={}", urlencoding::encode(value)))
        .unwrap_or_default();
    Ok(Json(SettingsNavigationResult {
        path: format!("/push?folderId={}{branch_param}", params.folder_id),
    }))
}

pub async fn add_folder_to_history(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<AddFolderParams>,
) -> Result<Json<FolderHistoryEntry>, AppCommandError> {
    Ok(Json(
        folder_commands::add_folder_to_history_core(&state.db, params.path).await?,
    ))
}

pub async fn remove_folder_from_history(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<AddFolderParams>,
) -> Result<Json<()>, AppCommandError> {
    folder_commands::remove_folder_from_history_core(&state.db, params.path).await?;
    Ok(Json(()))
}

pub async fn create_folder_directory(
    Json(params): Json<AddFolderParams>,
) -> Result<Json<()>, AppCommandError> {
    folder_commands::create_folder_directory(params.path).await?;
    Ok(Json(()))
}
