use std::sync::Arc;

use axum::{extract::Extension, Json};
use sea_orm::DatabaseConnection;
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::db::error::DbError;
use crate::db::service::folder_command_service;
use crate::models::*;

// ---------------------------------------------------------------------------
// Param structs
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListFolderCommandsParams {
    pub folder_id: i32,
    /// See [`visible_to_client`].
    #[serde(default)]
    pub include_local: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFolderCommandParams {
    pub folder_id: i32,
    pub name: String,
    pub command: String,
    pub run_local: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateFolderCommandParams {
    pub id: i32,
    pub name: Option<String>,
    pub command: Option<String>,
    pub sort_order: Option<i32>,
    pub run_local: Option<bool>,
    /// See [`visible_to_client`].
    #[serde(default)]
    pub include_local: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteFolderCommandParams {
    pub id: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderFolderCommandsParams {
    pub folder_id: i32,
    pub ids: Vec<i32>,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// The commands a client is shown. One the desktop app runs on its own
/// machine goes only to a client that says it knows that flag: an older one
/// would run the command's text in a terminal here, on the wrong machine.
fn visible_to_client(
    commands: Vec<FolderCommandInfo>,
    include_local: bool,
) -> Vec<FolderCommandInfo> {
    if include_local {
        return commands;
    }
    commands.into_iter().filter(|c| !c.run_local).collect()
}

pub async fn list_folder_commands(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ListFolderCommandsParams>,
) -> Result<Json<Vec<FolderCommandInfo>>, AppCommandError> {
    let db = &state.db;
    let result = folder_command_service::list_by_folder(&db.conn, params.folder_id)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(visible_to_client(result, params.include_local)))
}

pub async fn create_folder_command(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<CreateFolderCommandParams>,
) -> Result<Json<FolderCommandInfo>, AppCommandError> {
    let db = &state.db;
    let result = folder_command_service::create(
        &db.conn,
        params.folder_id,
        &params.name,
        &params.command,
        params.run_local.unwrap_or(false),
    )
    .await
    .map_err(AppCommandError::from)?;
    Ok(Json(result))
}

pub async fn update_folder_command(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UpdateFolderCommandParams>,
) -> Result<Json<FolderCommandInfo>, AppCommandError> {
    let result = update_for_client(&state.db.conn, params)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(result))
}

async fn update_for_client(
    conn: &DatabaseConnection,
    params: UpdateFolderCommandParams,
) -> Result<FolderCommandInfo, DbError> {
    // A client that isn't shown a local command (see `visible_to_client`) can
    // only hold its id from before it became one: to that client it is gone.
    if !params.include_local && folder_command_service::is_run_local(conn, params.id).await? {
        return Err(DbError::NotFound(format!("FolderCommand {}", params.id)));
    }
    folder_command_service::update(
        conn,
        params.id,
        params.name,
        params.command,
        params.sort_order,
        params.run_local,
    )
    .await
}

pub async fn delete_folder_command(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<DeleteFolderCommandParams>,
) -> Result<Json<()>, AppCommandError> {
    let db = &state.db;
    folder_command_service::delete(&db.conn, params.id)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(()))
}

pub async fn reorder_folder_commands(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ReorderFolderCommandsParams>,
) -> Result<Json<()>, AppCommandError> {
    let db = &state.db;
    folder_command_service::reorder(&db.conn, params.folder_id, params.ids)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapFolderCommandsParams {
    pub folder_id: i32,
    pub folder_path: String,
    /// See [`visible_to_client`].
    #[serde(default)]
    pub include_local: bool,
}

pub async fn bootstrap_folder_commands_from_package_json(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<BootstrapFolderCommandsParams>,
) -> Result<Json<Vec<FolderCommandInfo>>, AppCommandError> {
    let db = &state.db;

    let include_local = params.include_local;
    let existing = folder_command_service::list_by_folder(&db.conn, params.folder_id)
        .await
        .map_err(AppCommandError::from)?;
    if !existing.is_empty() {
        return Ok(Json(visible_to_client(existing, include_local)));
    }

    let commands_to_create = tokio::task::spawn_blocking(move || {
        crate::commands::folder_commands::load_package_scripts_as_commands(&params.folder_path)
    })
    .await
    .map_err(|e| {
        AppCommandError::new(
            crate::app_error::AppErrorCode::TaskExecutionFailed,
            format!("bootstrap task failed: {e}"),
        )
    })?;

    if commands_to_create.is_empty() {
        return Ok(Json(existing));
    }

    folder_command_service::create_many(&db.conn, params.folder_id, &commands_to_create)
        .await
        .map_err(AppCommandError::from)?;

    let result = folder_command_service::list_by_folder(&db.conn, params.folder_id)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(visible_to_client(result, include_local)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(id: i32, run_local: bool) -> FolderCommandInfo {
        FolderCommandInfo {
            id,
            folder_id: 1,
            name: format!("c{id}"),
            command: "x".to_string(),
            sort_order: 0,
            run_local,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        }
    }

    #[test]
    fn a_client_that_does_not_know_local_commands_is_not_shown_them() {
        let params: ListFolderCommandsParams =
            serde_json::from_value(serde_json::json!({ "folderId": 1 })).unwrap();
        assert!(!params.include_local);
        let shown = visible_to_client(vec![command(1, false), command(2, true)], false);
        assert_eq!(shown.iter().map(|c| c.id).collect::<Vec<_>>(), [1]);
    }

    #[tokio::test]
    async fn a_client_that_does_not_know_local_commands_cannot_edit_one() {
        use crate::db::test_helpers::{fresh_in_memory_db, seed_folder};

        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/repo").await;
        let local = folder_command_service::create(&db.conn, folder_id, "zed", "zed .", true)
            .await
            .unwrap();
        let terminal =
            folder_command_service::create(&db.conn, folder_id, "dev", "pnpm dev", false)
                .await
                .unwrap();
        let rename = |id: i32, include_local: bool| -> UpdateFolderCommandParams {
            serde_json::from_value(serde_json::json!({
                "id": id,
                "name": "renamed",
                "includeLocal": include_local,
            }))
            .unwrap()
        };

        let refused = update_for_client(&db.conn, rename(local.id, false)).await;
        assert!(matches!(refused, Err(DbError::NotFound(_))), "{refused:?}");
        let renamed = update_for_client(&db.conn, rename(terminal.id, false))
            .await
            .unwrap();
        assert_eq!(renamed.name, "renamed");
        let renamed = update_for_client(&db.conn, rename(local.id, true))
            .await
            .unwrap();
        assert_eq!(
            (renamed.name.as_str(), renamed.run_local),
            ("renamed", true)
        );
    }

    #[test]
    fn a_client_that_knows_local_commands_is_shown_them_all() {
        let params: BootstrapFolderCommandsParams = serde_json::from_value(
            serde_json::json!({ "folderId": 1, "folderPath": "/repo", "includeLocal": true }),
        )
        .unwrap();
        assert!(params.include_local);
        let shown = visible_to_client(vec![command(1, false), command(2, true)], true);
        assert_eq!(shown.iter().map(|c| c.id).collect::<Vec<_>>(), [1, 2]);
    }
}
