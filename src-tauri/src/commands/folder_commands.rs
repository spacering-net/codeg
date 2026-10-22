#[cfg(feature = "tauri-runtime")]
use crate::db::error::DbError;
#[cfg(feature = "tauri-runtime")]
use crate::db::service::folder_command_service;
#[cfg(feature = "tauri-runtime")]
use crate::db::AppDatabase;
#[cfg(feature = "tauri-runtime")]
use crate::models::FolderCommandInfo;
use std::path::Path;
#[cfg(feature = "tauri-runtime")]
use tokio::sync::Mutex;

#[cfg(feature = "tauri-runtime")]
static BOOTSTRAP_FOLDER_COMMANDS_LOCK: Mutex<()> = Mutex::const_new(());

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

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn bootstrap_folder_commands_from_package_json(
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
    folder_path: String,
) -> Result<Vec<FolderCommandInfo>, DbError> {
    let existing = folder_command_service::list_by_folder(&db.conn, folder_id).await?;
    if !existing.is_empty() {
        return Ok(existing);
    }

    let path_for_task = folder_path;
    let commands_to_create =
        tokio::task::spawn_blocking(move || load_package_scripts_as_commands(&path_for_task))
            .await
            .map_err(|e| DbError::Migration(format!("bootstrap task failed: {e}")))?;

    if commands_to_create.is_empty() {
        return Ok(existing);
    }

    // Serialize bootstrap so concurrent calls do not create duplicate commands.
    let _bootstrap_guard = BOOTSTRAP_FOLDER_COMMANDS_LOCK.lock().await;

    let latest = folder_command_service::list_by_folder(&db.conn, folder_id).await?;
    if !latest.is_empty() {
        return Ok(latest);
    }

    folder_command_service::create_many(&db.conn, folder_id, &commands_to_create).await?;

    folder_command_service::list_by_folder(&db.conn, folder_id).await
}
