use std::collections::HashSet;
use std::path::Path;

use sea_orm::DatabaseConnection;
use tokio::sync::Mutex;

use crate::db::error::DbError;
use crate::db::service::folder_command_service;
use crate::models::FolderCommandInfo;

#[cfg(feature = "tauri-runtime")]
use crate::db::AppDatabase;

static SYNC_FOLDER_COMMANDS_LOCK: Mutex<()> = Mutex::const_new(());

pub(crate) fn load_package_scripts_as_commands(folder_path: &str) -> Vec<(String, String)> {
    let mut has_package_json = false;
    let mut has_pnpm_lock = false;
    let mut has_yarn_lock = false;
    let mut has_bun_lock = false;

    let entries = match std::fs::read_dir(folder_path) {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };

    for entry in entries.flatten() {
        let Some(file_name) = entry.file_name().to_str().map(|s| s.to_string()) else {
            continue;
        };
        match file_name.as_str() {
            "package.json" => has_package_json = true,
            "pnpm-lock.yaml" => has_pnpm_lock = true,
            "yarn.lock" => has_yarn_lock = true,
            "bun.lockb" | "bun.lock" => has_bun_lock = true,
            _ => {}
        }
    }

    if !has_package_json {
        return Vec::new();
    }

    let package_json_path = Path::new(folder_path).join("package.json");
    let package_json_content = match std::fs::read_to_string(package_json_path) {
        Ok(content) => content,
        Err(_) => return Vec::new(),
    };

    let package_json: serde_json::Value = match serde_json::from_str(&package_json_content) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };

    let package_manager = if has_pnpm_lock {
        "pnpm"
    } else if has_yarn_lock {
        "yarn"
    } else if has_bun_lock {
        "bun"
    } else {
        "npm"
    };

    let mut commands = Vec::new();
    if let Some(scripts) = package_json.get("scripts").and_then(|s| s.as_object()) {
        for (script_name, script_value) in scripts {
            if script_name.trim().is_empty() || script_value.as_str().is_none() {
                continue;
            }
            commands.push((
                script_name.to_string(),
                format!("{package_manager} run {script_name}"),
            ));
        }
    }

    commands
}

/// Every command, `run_local` ones too: this app's own frontend is the only
/// caller here, and it knows that flag (unlike an older client of the HTTP
/// route, which `web::handlers::folder_commands` guards against).
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn list_folder_commands(
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
) -> Result<Vec<FolderCommandInfo>, DbError> {
    folder_command_service::list_by_folder(&db.conn, folder_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn create_folder_command(
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
    name: String,
    command: String,
    run_local: Option<bool>,
) -> Result<FolderCommandInfo, DbError> {
    folder_command_service::create(
        &db.conn,
        folder_id,
        &name,
        &command,
        run_local.unwrap_or(false),
    )
    .await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn update_folder_command(
    db: tauri::State<'_, AppDatabase>,
    id: i32,
    name: Option<String>,
    command: Option<String>,
    sort_order: Option<i32>,
    run_local: Option<bool>,
) -> Result<FolderCommandInfo, DbError> {
    folder_command_service::update(&db.conn, id, name, command, sort_order, run_local).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn delete_folder_command(
    db: tauri::State<'_, AppDatabase>,
    id: i32,
) -> Result<(), DbError> {
    folder_command_service::delete(&db.conn, id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn reorder_folder_commands(
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
    ids: Vec<i32>,
) -> Result<(), DbError> {
    folder_command_service::reorder(&db.conn, folder_id, ids).await
}

/// Add-only sync from package.json scripts into the folder's saved commands.
/// A script whose name already has a saved command is skipped — the saved
/// entry (possibly renamed or edited by the user) is never touched, and
/// scripts removed from package.json are never deleted here.
pub(crate) async fn sync_folder_commands_core(
    conn: &DatabaseConnection,
    folder_id: i32,
    folder_path: String,
) -> Result<Vec<FolderCommandInfo>, DbError> {
    let existing = folder_command_service::list_by_folder(conn, folder_id).await?;

    let scripts =
        tokio::task::spawn_blocking(move || load_package_scripts_as_commands(&folder_path))
            .await
            .map_err(|e| DbError::Migration(format!("sync task failed: {e}")))?;

    if scripts.is_empty() {
        return Ok(existing);
    }

    // Serialize sync so concurrent calls do not create duplicate commands.
    let _sync_guard = SYNC_FOLDER_COMMANDS_LOCK.lock().await;

    let latest = folder_command_service::list_by_folder(conn, folder_id).await?;
    let existing_names: HashSet<&str> = latest.iter().map(|c| c.name.as_str()).collect();
    let missing: Vec<(String, String)> = scripts
        .into_iter()
        .filter(|(name, _)| !existing_names.contains(name.as_str()))
        .collect();

    if missing.is_empty() {
        return Ok(latest);
    }

    folder_command_service::create_many(conn, folder_id, &missing).await?;

    folder_command_service::list_by_folder(conn, folder_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn sync_folder_commands_from_package_json(
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
    folder_path: String,
) -> Result<Vec<FolderCommandInfo>, DbError> {
    sync_folder_commands_core(&db.conn, folder_id, folder_path).await
}
