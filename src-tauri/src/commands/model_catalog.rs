//! The model catalog's settings and commands (both runtimes).

#[cfg(feature = "tauri-runtime")]
use std::path::PathBuf;

#[cfg(feature = "tauri-runtime")]
use tauri::{Manager, State};

use crate::app_error::AppCommandError;
#[cfg(feature = "tauri-runtime")]
use crate::db::AppDatabase;
use crate::model_catalog::{self, CatalogSettings, CatalogStatus, CatalogView};

pub(crate) async fn load_model_catalog_settings_core(
    conn: &sea_orm::DatabaseConnection,
) -> Result<CatalogSettings, AppCommandError> {
    model_catalog::load_settings(conn).await
}

pub(crate) async fn update_model_catalog_settings_core(
    conn: &sea_orm::DatabaseConnection,
    settings: CatalogSettings,
) -> Result<CatalogSettings, AppCommandError> {
    let normalized = model_catalog::normalize_settings(settings)?;
    model_catalog::save_settings(conn, &normalized).await?;
    Ok(normalized)
}

pub(crate) async fn get_model_catalog_core(
    data_dir: &std::path::Path,
    conn: &sea_orm::DatabaseConnection,
    force: bool,
) -> Result<CatalogView, AppCommandError> {
    model_catalog::view_core(data_dir, conn, force).await
}

pub(crate) async fn refresh_model_catalog_core(
    data_dir: &std::path::Path,
    conn: &sea_orm::DatabaseConnection,
) -> Result<CatalogStatus, AppCommandError> {
    model_catalog::status_core(data_dir, conn, true).await
}

#[cfg(feature = "tauri-runtime")]
fn data_dir_of(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .map(|p| crate::paths::resolve_effective_data_dir(&p))
        .unwrap_or_else(|_| PathBuf::from("."))
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_model_catalog(
    force: Option<bool>,
    app: tauri::AppHandle,
    db: State<'_, AppDatabase>,
) -> Result<CatalogView, AppCommandError> {
    get_model_catalog_core(&data_dir_of(&app), &db.conn, force.unwrap_or(false)).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn refresh_model_catalog(
    app: tauri::AppHandle,
    db: State<'_, AppDatabase>,
) -> Result<CatalogStatus, AppCommandError> {
    refresh_model_catalog_core(&data_dir_of(&app), &db.conn).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_model_catalog_settings(
    db: State<'_, AppDatabase>,
) -> Result<CatalogSettings, AppCommandError> {
    load_model_catalog_settings_core(&db.conn).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn update_model_catalog_settings(
    settings: CatalogSettings,
    db: State<'_, AppDatabase>,
) -> Result<CatalogSettings, AppCommandError> {
    update_model_catalog_settings_core(&db.conn, settings).await
}
