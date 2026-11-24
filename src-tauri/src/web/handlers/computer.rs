//! HTTP handlers for codeg's Computer use panel — the web-mode mirror of the
//! Tauri commands in `commands::computer`.
//!
//! Only codeg-server answers them, and only where the person who runs it has
//! let it share the screen it runs on (`CODEG_COMPUTER_USE`): its web
//! clients — each holding the server's token, as every route here requires —
//! are then the only panel there is, from which windows are shared and Stop
//! is pressed. Anywhere else (a server not let share its screen, the desktop
//! app's own web service, whose screen is shared from the desktop window
//! itself) every call is refused, and `computer_available` says so up front.

use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::{Deserialize, Serialize};

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::computer::{
    computer_driver_info_core, computer_driver_install_core, computer_driver_uninstall_core,
    computer_list_shareable_windows_core, computer_request_permission_core,
    computer_revoke_all_core, computer_share_app_core, computer_share_screen_core,
    computer_share_window_core, computer_share_windows_core, computer_shared_state_core,
    computer_status_core, computer_stop_core, computer_stop_key_status_core,
    computer_window_thumbnail_core, permission_settings_url, platform_name, ComputerService,
    ComputerStatus, PermissionRequestResult, PickerWindow, ShareManyResult, SharedState,
};
use crate::computer::agent::GrantLevel;
use crate::computer::driver_admin::DriverInfo;
use crate::computer::protocol::OsPermission;
use crate::computer::stop_shortcut::StopKeyStatus;
use crate::computer::targets::SharedWindow;

/// The computer service this process runs for its web clients, or the
/// refusal that says why there is none.
fn served(state: &AppState) -> Result<&Arc<ComputerService>, AppCommandError> {
    state.computer_service.get().ok_or_else(|| {
        AppCommandError::configuration_invalid(
            "computer use is not available here: codeg-server offers it only when started with \
             CODEG_COMPUTER_USE=1 in a desktop session, and the desktop app only in its own \
             window",
        )
    })
}

/// What `computer_available` answers.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerServed {
    /// This server shares the screen it runs on with its web clients.
    pub available: bool,
    /// `macos` / `windows` / `linux`: the machine whose screen that is —
    /// which a web client cannot tell from its own.
    pub platform: &'static str,
}

/// Whether this server shares its screen with its web clients at all, and
/// what machine that screen is on.
pub async fn computer_available(
    Extension(state): Extension<Arc<AppState>>,
) -> Json<ComputerServed> {
    Json(ComputerServed {
        available: state.computer_service.get().is_some(),
        platform: platform_name(),
    })
}

pub async fn computer_status(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<ComputerStatus>, AppCommandError> {
    Ok(Json(computer_status_core(served(&state)?).await?))
}

#[derive(Deserialize)]
pub struct PermissionParams {
    pub permission: OsPermission,
}

pub async fn computer_request_permission(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<PermissionParams>,
) -> Result<Json<PermissionRequestResult>, AppCommandError> {
    Ok(Json(
        computer_request_permission_core(served(&state)?, params.permission).await?,
    ))
}

/// Open System Settings at the pane for one permission — on the screen this
/// server runs on, where the person at it grants it.
pub async fn computer_open_permission_settings(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<PermissionParams>,
) -> Result<Json<()>, AppCommandError> {
    served(&state)?;
    if let Some(url) = permission_settings_url(params.permission) {
        open_on_this_machine(&["/usr/bin/open", &url])?;
    }
    Ok(Json(()))
}

/// Show codeg-computer-helper where the person at this machine can drag it
/// into System Settings' list by hand.
pub async fn computer_reveal_helper(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<()>, AppCommandError> {
    served(&state)?;
    let helper = crate::computer::local::helper_to_reveal()
        .await
        .map_err(|e| AppCommandError::configuration_invalid(e.to_string()))?;
    let helper = helper.to_string_lossy().to_string();
    if cfg!(target_os = "macos") {
        open_on_this_machine(&["/usr/bin/open", "-R", &helper])?;
    } else if cfg!(windows) {
        open_on_this_machine(&["explorer.exe", &format!("/select,{helper}")])?;
    }
    Ok(Json(()))
}

/// Run one of the system's own openers, with fixed arguments, on this
/// machine; it is not waited for.
fn open_on_this_machine(command: &[&str]) -> Result<(), AppCommandError> {
    let (program, args) = command
        .split_first()
        .ok_or_else(|| AppCommandError::configuration_invalid("nothing to open"))?;
    std::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| AppCommandError::configuration_invalid(e.to_string()))
}

pub async fn computer_list_shareable_windows(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<Vec<PickerWindow>>, AppCommandError> {
    Ok(Json(
        computer_list_shareable_windows_core(served(&state)?).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetParams {
    pub target_id: String,
}

pub async fn computer_window_thumbnail(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<TargetParams>,
) -> Result<Json<Option<String>>, AppCommandError> {
    Ok(Json(
        computer_window_thumbnail_core(served(&state)?, &params.target_id).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareWindowParams {
    pub target_id: String,
    pub level: GrantLevel,
}

pub async fn computer_share_window(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ShareWindowParams>,
) -> Result<Json<Vec<SharedWindow>>, AppCommandError> {
    Ok(Json(
        computer_share_window_core(served(&state)?, &params.target_id, params.level).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareWindowsParams {
    pub target_ids: Vec<String>,
    pub level: GrantLevel,
}

pub async fn computer_share_windows(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ShareWindowsParams>,
) -> Result<Json<ShareManyResult>, AppCommandError> {
    Ok(Json(
        computer_share_windows_core(served(&state)?, &params.target_ids, params.level).await?,
    ))
}

pub async fn computer_shared_state(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<SharedState>, AppCommandError> {
    Ok(Json(computer_shared_state_core(served(&state)?)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareAppParams {
    #[serde(default)]
    pub target_id: Option<String>,
    #[serde(default)]
    pub app_id: Option<String>,
    pub level: GrantLevel,
}

pub async fn computer_share_app(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ShareAppParams>,
) -> Result<Json<SharedState>, AppCommandError> {
    Ok(Json(
        computer_share_app_core(
            served(&state)?,
            params.target_id.as_deref(),
            params.app_id.as_deref(),
            params.level,
        )
        .await?,
    ))
}

#[derive(Deserialize)]
pub struct ShareScreenParams {
    pub level: GrantLevel,
}

pub async fn computer_share_screen(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ShareScreenParams>,
) -> Result<Json<SharedState>, AppCommandError> {
    Ok(Json(
        computer_share_screen_core(served(&state)?, params.level).await?,
    ))
}

pub async fn computer_revoke_all(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<()>, AppCommandError> {
    computer_revoke_all_core(served(&state)?);
    Ok(Json(()))
}

pub async fn computer_stop(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<()>, AppCommandError> {
    computer_stop_core(served(&state)?).await;
    Ok(Json(()))
}

pub async fn computer_stop_key_status(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<StopKeyStatus>, AppCommandError> {
    Ok(Json(computer_stop_key_status_core(served(&state)?)))
}

pub async fn computer_driver_info(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<DriverInfo>, AppCommandError> {
    Ok(Json(computer_driver_info_core(served(&state)?)))
}

pub async fn computer_driver_install(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<DriverInfo>, AppCommandError> {
    Ok(Json(computer_driver_install_core(served(&state)?).await?))
}

pub async fn computer_driver_uninstall(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<DriverInfo>, AppCommandError> {
    let service = served(&state)?;
    Ok(Json(
        computer_driver_uninstall_core(service, &state.db.conn).await?,
    ))
}
