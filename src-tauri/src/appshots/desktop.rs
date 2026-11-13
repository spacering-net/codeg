//! Native IPC only: no HTTP route or agent tool exposes this user gesture.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use super::Appshot;
use crate::acp::computer_tools::ComputerToolsRuntimeConfig;
use crate::app_error::AppCommandError;
use crate::computer::agent::{Blocklist, SelfIdentity};
use crate::computer::keys::Platform;
use crate::computer::local::LocalBackend;
use crate::computer::stop_key::StopKey;
use crate::computer::stop_shortcut::{StopKeyStatus, StopShortcut};
use crate::db::{service::app_metadata_service, AppDatabase};

const SETTINGS_KEY: &str = "desktop.appshots.shortcut";
const READY: &str = "appshots://ready";

pub struct Appshots {
    app: AppHandle,
    shortcut: StopKey,
    setting: tokio::sync::Mutex<Option<String>>,
    busy: AtomicBool,
    pending: Mutex<Option<Result<Appshot, String>>>,
    config: ComputerToolsRuntimeConfig,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub shortcut: String,
    pub status: StopKeyStatus,
}

impl Appshots {
    pub fn start(app: AppHandle, config: ComputerToolsRuntimeConfig) -> Arc<Self> {
        let state = Arc::new(Self {
            app: app.clone(),
            shortcut: StopKey::new(),
            setting: tokio::sync::Mutex::new(None),
            busy: AtomicBool::new(false),
            pending: Mutex::new(None),
            config,
        });
        app.manage(state.clone());
        let init = state.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = init.settings().await {
                tracing::warn!("[appshots] could not load shortcut: {e}");
            }
        });
        state
    }

    async fn settings(self: &Arc<Self>) -> Result<Settings, AppCommandError> {
        let mut setting = self.setting.lock().await;
        if setting.is_none() {
            let raw = app_metadata_service::get_value(
                &self.app.state::<AppDatabase>().conn,
                SETTINGS_KEY,
            )
            .await?;
            // Opt in by choosing a shortcut. Merely upgrading codeg must not
            // reserve a system-wide key combination used by another app.
            let wanted = raw.unwrap_or_default();
            self.register(&wanted)?;
            *setting = Some(wanted);
        }
        Ok(Settings {
            shortcut: setting.clone().unwrap_or_default(),
            status: self.shortcut.status(),
        })
    }

    fn register(self: &Arc<Self>, value: &str) -> Result<(), AppCommandError> {
        let wanted = if value.is_empty() {
            None
        } else {
            Some(
                StopShortcut::parse(value, Platform::current())
                    .map_err(|e| AppCommandError::configuration_invalid(e.to_string()))?,
            )
        };
        let state = self.clone();
        self.shortcut.sync(&self.app, wanted.as_ref(), move || {
            state.request(0);
        });
        Ok(())
    }

    fn request(self: &Arc<Self>, delay_ms: u64) -> bool {
        if self.busy.swap(true, Ordering::AcqRel) {
            return false;
        }
        // Keep an unreviewed snapshot instead of replacing it invisibly.
        if self
            .pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_some()
        {
            self.busy.store(false, Ordering::Release);
            self.present();
            return false;
        }
        let state = self.clone();
        tauri::async_runtime::spawn(async move {
            if delay_ms > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
            }
            let backend = LocalBackend::new(|_| {});
            backend.open().await;
            let config = state.config.snapshot().await;
            let rules = Blocklist::configured(&config.blocklist, &config.blocklist_removed);
            let mut result = super::capture(&backend, &SelfIdentity::current(), &rules).await;
            // An application excluded while capture was in progress stays
            // excluded, even though this read creates no persistent grant.
            if let Ok(shot) = &result {
                let now = state.config.snapshot().await;
                let rules = Blocklist::configured(&now.blocklist, &now.blocklist_removed);
                let app = crate::computer::protocol::RawApp {
                    pid: 0,
                    name: shot.app_name.clone(),
                    bundle_id: Some(shot.app_key.clone()),
                    path: Some(shot.app_key.clone()),
                    active: false,
                    started_at: None,
                };
                if rules.matches(&app) {
                    result = Err("excluded-app".to_string());
                }
            }
            // This backend has no agent switch or grants; its lifetime is
            // exactly this one user-initiated operation.
            backend.close_now().await;
            *state.pending.lock().unwrap_or_else(|p| p.into_inner()) = Some(result);
            state.busy.store(false, Ordering::Release);
            state.present();
        });
        true
    }

    fn present(&self) {
        if let Some(window) = self.app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
            // Only the main window fetches the payload through native IPC, not
            // through a broadcast to
            // other workspaces or remote browser clients.
            let _ = window.emit(READY, ());
        }
    }
}

fn main_window(window: &WebviewWindow) -> Result<(), AppCommandError> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err(AppCommandError::configuration_invalid(
            "Appshots are available in the main desktop window",
        ))
    }
}

#[tauri::command]
pub async fn appshot_get_settings(
    window: WebviewWindow,
    state: State<'_, Arc<Appshots>>,
) -> Result<Settings, AppCommandError> {
    main_window(&window)?;
    state.settings().await
}

#[tauri::command]
pub async fn appshot_set_shortcut(
    window: WebviewWindow,
    state: State<'_, Arc<Appshots>>,
    shortcut: String,
) -> Result<Settings, AppCommandError> {
    main_window(&window)?;
    let mut setting = state.setting.lock().await;
    if !shortcut.is_empty() {
        StopShortcut::parse(&shortcut, Platform::current())
            .map_err(|e| AppCommandError::configuration_invalid(e.to_string()))?;
    }
    app_metadata_service::upsert_value(
        &state.app.state::<AppDatabase>().conn,
        SETTINGS_KEY,
        &shortcut,
    )
    .await?;
    state.inner().register(&shortcut)?;
    *setting = Some(shortcut.clone());
    Ok(Settings {
        shortcut,
        status: state.shortcut.status(),
    })
}

#[tauri::command]
pub fn appshot_capture(
    window: WebviewWindow,
    state: State<'_, Arc<Appshots>>,
    delayed: bool,
) -> Result<bool, AppCommandError> {
    main_window(&window)?;
    Ok(state.inner().request(if delayed { 3000 } else { 0 }))
}

#[tauri::command]
pub fn appshot_take_pending(
    window: WebviewWindow,
    state: State<'_, Arc<Appshots>>,
) -> Result<Option<Result<Appshot, String>>, AppCommandError> {
    main_window(&window)?;
    Ok(state
        .pending
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone())
}

#[tauri::command]
pub fn appshot_dismiss(
    window: WebviewWindow,
    state: State<'_, Arc<Appshots>>,
    id: Option<String>,
) -> Result<(), AppCommandError> {
    main_window(&window)?;
    let mut pending = state.pending.lock().unwrap_or_else(|p| p.into_inner());
    let pending_id = pending
        .as_ref()
        .and_then(|r| r.as_ref().ok())
        .map(|s| s.id.as_str());
    if pending_id == id.as_deref() {
        *pending = None;
    }
    Ok(())
}
