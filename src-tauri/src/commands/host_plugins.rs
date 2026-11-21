use std::sync::Arc;
use uuid::Uuid;

use crate::app_error::AppCommandError;
use crate::host_plugins::source::{self, PluginIndex, Registry};
use crate::host_plugins::{
    ExpectedPlugin, HostPlugins, InstallPreview, InstalledPlugin, Mutation, PluginSettings,
    PluginUpdate, SettingsRequest, CATALOG_CHANGED,
};
use crate::web::event_bridge::{emit_event, EventEmitter};

pub async fn apply_core(
    plugins: &Arc<HostPlugins>,
    emitter: &EventEmitter,
    mutation: Mutation,
) -> Result<Vec<InstalledPlugin>, AppCommandError> {
    let plugins = plugins.clone();
    let catalog = tokio::task::spawn_blocking(move || plugins.apply(mutation))
        .await
        .map_err(|_| {
            AppCommandError::new(
                crate::app_error::AppErrorCode::TaskExecutionFailed,
                "Plugin catalog update stopped",
            )
        })??;
    emit_event(emitter, CATALOG_CHANGED, ());
    Ok(catalog)
}

pub async fn settings_core(
    plugins: &Arc<HostPlugins>,
    plugin_id: String,
    request: SettingsRequest,
) -> Result<PluginSettings, AppCommandError> {
    let plugins = plugins.clone();
    tokio::task::spawn_blocking(move || match request {
        SettingsRequest::Read => plugins.settings(&plugin_id),
        SettingsRequest::Save { revision, value } => {
            plugins.save_settings(&plugin_id, revision, value)
        }
    })
    .await
    .map_err(|_| {
        AppCommandError::new(
            crate::app_error::AppErrorCode::TaskExecutionFailed,
            "Plugin settings operation stopped",
        )
    })?
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

pub async fn preview_install_core(
    plugins: &HostPlugins,
    input: &str,
    registry: Registry,
    expected: Option<ExpectedPlugin>,
) -> Result<InstallPreview, AppCommandError> {
    plugins.preview_install(input, registry, expected).await
}

pub fn confirm_install_core(
    plugins: &HostPlugins,
    emitter: &EventEmitter,
    ticket: Uuid,
) -> Result<Vec<InstalledPlugin>, AppCommandError> {
    let catalog = plugins.confirm_install(ticket)?;
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
    apply_core(&plugins, &EventEmitter::from_app(&app), mutation).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn host_plugins_settings(
    plugins: tauri::State<'_, Arc<HostPlugins>>,
    plugin_id: String,
    request: SettingsRequest,
) -> Result<PluginSettings, AppCommandError> {
    settings_core(&plugins, plugin_id, request).await
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
pub async fn host_plugins_call(
    plugins: tauri::State<'_, Arc<HostPlugins>>,
    plugin_id: String,
    method: String,
    input: serde_json::Value,
) -> Result<serde_json::Value, AppCommandError> {
    plugins.call(&plugin_id, method, input).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn host_plugins_client_html(
    plugins: tauri::State<'_, Arc<HostPlugins>>,
    plugin_id: String,
) -> Result<Arc<str>, AppCommandError> {
    plugins.client_html(&plugin_id)
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

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn host_plugins_preview_install(
    plugins: tauri::State<'_, Arc<HostPlugins>>,
    input: String,
    registry: Registry,
    expected: Option<ExpectedPlugin>,
) -> Result<InstallPreview, AppCommandError> {
    preview_install_core(&plugins, &input, registry, expected).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn host_plugins_confirm_install(
    app: tauri::AppHandle,
    plugins: tauri::State<'_, Arc<HostPlugins>>,
    ticket: Uuid,
) -> Result<Vec<InstalledPlugin>, AppCommandError> {
    confirm_install_core(&plugins, &EventEmitter::from_app(&app), ticket)
}
