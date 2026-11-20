use crate::app_error::AppCommandError;
use crate::host_plugins::{HostPlugins, InstalledPlugin, Mutation, CATALOG_CHANGED};
use crate::web::event_bridge::{emit_event, EventEmitter};

pub fn apply_core(
    plugins: &HostPlugins,
    emitter: &EventEmitter,
    mutation: Mutation,
) -> Result<Vec<InstalledPlugin>, AppCommandError> {
    let catalog = plugins.apply(mutation)?;
    emit_event(emitter, CATALOG_CHANGED, ());
    Ok(catalog)
}

#[cfg(feature = "tauri-runtime")]
use std::sync::Arc;

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn host_plugins_list(
    plugins: tauri::State<'_, Arc<HostPlugins>>,
) -> Result<Vec<InstalledPlugin>, AppCommandError> {
    plugins.list()
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn host_plugins_apply(
    app: tauri::AppHandle,
    plugins: tauri::State<'_, Arc<HostPlugins>>,
    mutation: Mutation,
) -> Result<Vec<InstalledPlugin>, AppCommandError> {
    apply_core(&plugins, &EventEmitter::from_app(&app), mutation)
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn host_plugins_activity(
    plugins: tauri::State<'_, Arc<HostPlugins>>,
    plugin_id: String,
    folder_id: i32,
) -> Result<Vec<crate::host_plugins::TurnActivity>, AppCommandError> {
    plugins.activity(&plugin_id, folder_id)
}
