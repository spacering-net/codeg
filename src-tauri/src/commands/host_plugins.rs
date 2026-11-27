use crate::app_error::AppCommandError;
use crate::host_plugins::source::{self, PluginIndex, Registry};
use crate::host_plugins::{HostPlugins, InstalledPlugin, Mutation, PluginUpdate, CATALOG_CHANGED};
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

pub async fn install_source_core(
    plugins: &HostPlugins,
    emitter: &EventEmitter,
    input: &str,
    registry: Registry,
) -> Result<Vec<InstalledPlugin>, AppCommandError> {
    let catalog = source::install(plugins, input, registry).await?;
    emit_event(emitter, CATALOG_CHANGED, ());
    Ok(catalog)
}

pub async fn update_core(
    plugins: &HostPlugins,
    emitter: &EventEmitter,
    plugin_id: &str,
) -> Result<PluginUpdate, AppCommandError> {
    let update = plugins.update(plugin_id).await?;
    if update.updated {
        emit_event(emitter, CATALOG_CHANGED, ());
    }
    Ok(update)
}

pub async fn fetch_index_core(url: &str) -> Result<PluginIndex, AppCommandError> {
    source::fetch_index(url).await
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

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn host_plugins_install_source(
    app: tauri::AppHandle,
    plugins: tauri::State<'_, Arc<HostPlugins>>,
    input: String,
    registry: Option<Registry>,
) -> Result<Vec<InstalledPlugin>, AppCommandError> {
    let emitter = EventEmitter::from_app(&app);
    install_source_core(&plugins, &emitter, &input, registry.unwrap_or_default()).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn host_plugins_update(
    app: tauri::AppHandle,
    plugins: tauri::State<'_, Arc<HostPlugins>>,
    plugin_id: String,
) -> Result<PluginUpdate, AppCommandError> {
    update_core(&plugins, &EventEmitter::from_app(&app), &plugin_id).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn host_plugins_fetch_index(url: String) -> Result<PluginIndex, AppCommandError> {
    fetch_index_core(&url).await
}
