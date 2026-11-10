use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::{Deserialize, Serialize};

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::web::{
    do_get_web_server_status, do_probe_web_service_port, do_stop_web_server,
    load_web_service_config, update_web_service_config_core, WebServerInfo, WebServiceConfig,
    WebServicePortProbe,
};

pub async fn get_web_server_status(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<Option<WebServerInfo>>, AppCommandError> {
    Ok(Json(do_get_web_server_status(&state.web_server_state)))
}

pub async fn get_web_service_config(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<WebServiceConfig>, AppCommandError> {
    load_web_service_config(&state.db.conn).await.map(Json)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateWebServiceConfigParams {
    pub config: WebServiceConfig,
}

pub async fn update_web_service_config(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UpdateWebServiceConfigParams>,
) -> Result<Json<WebServiceConfig>, AppCommandError> {
    update_web_service_config_core(&state.db.conn, params.config)
        .await
        .map(Json)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartWebServerParams {
    pub port: Option<u16>,
    pub host: Option<String>,
    pub token: Option<String>,
}

pub async fn start_web_server(
    Extension(state): Extension<Arc<AppState>>,
    Json(_params): Json<StartWebServerParams>,
) -> Result<Json<WebServerInfo>, AppCommandError> {
    // In web mode, the server is already running (this handler itself is served by it).
    // This endpoint is mainly useful in Tauri mode. Return current status as a noop.
    let ws = &state.web_server_state;
    if ws.running.load(std::sync::atomic::Ordering::Relaxed) {
        if let Some(info) = do_get_web_server_status(ws) {
            return Ok(Json(info));
        }
    }
    Err(AppCommandError::new(
        crate::app_error::AppErrorCode::InvalidInput,
        "Cannot start web server from within web mode",
    ))
}

pub async fn stop_web_server(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<()>, AppCommandError> {
    // In web mode the serve task is owned by `codeg-server`'s main loop,
    // not WebServerState. Calling do_stop_web_server here would not stop
    // the process but WOULD trigger shutdown_signal — killing every live
    // WebSocket including the caller's own session. Reject instead.
    if state.web_server_state.is_externally_managed() {
        return Err(AppCommandError::new(
            crate::app_error::AppErrorCode::InvalidInput,
            "Cannot stop web server from within web mode",
        ));
    }
    do_stop_web_server(&state.web_server_state).await;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeWebServicePortParams {
    pub port: Option<u16>,
}

pub async fn probe_web_service_port(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ProbeWebServicePortParams>,
) -> Result<Json<WebServicePortProbe>, AppCommandError> {
    do_probe_web_service_port(&state.db.conn, params.port)
        .await
        .map(Json)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    pub version: String,
    pub body: String,
    pub date: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateCheckResult {
    pub current_version: String,
    pub update: Option<AppUpdateInfo>,
    /// Whether *this* process can apply the update in place. True for the
    /// standalone server build on a supported platform; false on desktop
    /// (which updates via Tauri's own updater) and on unknown platforms.
    /// When false the frontend falls back to a "view release" link.
    pub self_update_supported: bool,
    /// How a self-update would restart: `"supervised"` (our `--supervise`
    /// parent relaunches) or `"reexec"` (the process re-execs itself).
    pub capability: crate::update::runtime::UpdateCapability,
    /// `"docker"` | `"standalone"` — drives the post-upgrade hint.
    pub runtime: String,
    /// Relaunch delay (ms) the frontend countdown should use after a
    /// supervised restart.
    pub restart_delay_ms: u64,
    /// A previous version is staged in `.bak` and can be rolled back to.
    pub rollback_available: bool,
    /// This server speaks the detached `app_update_state` protocol (background
    /// download + progress events + ready-to-restart snapshot). Always true on
    /// this build; absent on older servers, which a newer client must treat as
    /// unsupported rather than driving the new flow against the old blocking
    /// `perform_app_update`.
    pub live_progress: bool,
}

#[cfg(feature = "tauri-runtime")]
fn server_self_update_supported() -> bool {
    // Desktop builds self-update through `tauri-plugin-updater`; the embedded
    // web server must never swap the desktop binary with a server tarball.
    false
}

#[cfg(not(feature = "tauri-runtime"))]
fn server_self_update_supported() -> bool {
    // Windows server self-update is intentionally disabled: swapping a running
    // .exe and the standalone re-exec port rebind have not been validated on a
    // real Windows host. Only Linux/macOS are supported for now. (The desktop
    // Windows app is unaffected — it updates via tauri-plugin-updater.)
    !cfg!(target_os = "windows") && crate::update::install::asset_basename().is_some()
}

#[cfg(feature = "tauri-runtime")]
fn server_rollback_available() -> bool {
    false
}

#[cfg(not(feature = "tauri-runtime"))]
fn server_rollback_available() -> bool {
    crate::update::install::rollback_available()
}

#[cfg(feature = "tauri-runtime")]
fn server_self_update_blocker() -> Option<AppCommandError> {
    None
}

#[cfg(not(feature = "tauri-runtime"))]
fn server_self_update_blocker() -> Option<AppCommandError> {
    // Only meaningful where an in-place update could run at all; elsewhere
    // `self_update_supported` is already false and says it all.
    if !server_self_update_supported() {
        return None;
    }
    crate::update::install::self_update_blocker()
}

pub async fn check_app_update() -> Result<Json<AppUpdateCheckResult>, AppCommandError> {
    use crate::update::{runtime, version};

    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let manifest = version::fetch_latest_manifest().await?;

    let update = if version::is_newer(&manifest.version, &current_version) {
        Some(AppUpdateInfo {
            version: version::trim_v_prefix(&manifest.version).to_string(),
            body: manifest.notes.unwrap_or_default(),
            date: manifest.pub_date,
        })
    } else {
        None
    };

    Ok(Json(AppUpdateCheckResult {
        current_version,
        update,
        self_update_supported: server_self_update_supported(),
        capability: runtime::capability(),
        runtime: runtime::runtime_label().to_string(),
        restart_delay_ms: runtime::restart_delay_ms(),
        rollback_available: server_rollback_available(),
        live_progress: true,
    }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerUpdateStatus {
    /// The running binary's own version — read locally (no manifest), so the
    /// settings page can show the current version even when the release source
    /// is unreachable.
    pub current_version: String,
    /// Whether this process can apply an in-place update (server build on a
    /// supported platform). Local — no network.
    pub self_update_supported: bool,
    /// How a self-update would restart: `"supervised"` or `"reexec"`.
    pub capability: crate::update::runtime::UpdateCapability,
    /// `"docker"` | `"standalone"` — drives the post-upgrade hint.
    pub runtime: String,
    /// Relaunch delay (ms) the frontend countdown should use.
    pub restart_delay_ms: u64,
    /// A previous version is staged in `.bak` and can be rolled back to.
    pub rollback_available: bool,
    /// This server speaks the detached `app_update_state` protocol. See
    /// [`AppUpdateCheckResult::live_progress`].
    pub live_progress: bool,
    /// Why an in-place update cannot run here even though the platform
    /// supports one — today an install location this process cannot write
    /// (when the write is refused outright, a rollback can't run either). The
    /// very error the update would fail with, so the UI can offer the manual
    /// route and say why before anyone clicks. Only here, not on
    /// [`check_app_update`]: one source keeps an older answer from overwriting
    /// a newer one. Absent when nothing is in the way, and on older servers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub self_update_blocker: Option<AppCommandError>,
}

/// Local-only counterpart to [`check_app_update`]: reports what this process
/// can do (self-update capability, rollback availability, and whatever stands
/// in the way of either) WITHOUT contacting the release source. The manual
/// rollback affordance must stay reachable even when the update manifest is
/// unreachable (proxy, outage, air-gap), since `rollback_app` is an entirely
/// local operation — gating it behind the network-dependent update check would
/// hide it exactly when recovery is most needed.
pub async fn app_update_status() -> Json<ServerUpdateStatus> {
    use crate::update::runtime;
    Json(ServerUpdateStatus {
        current_version: env!("CARGO_PKG_VERSION").to_string(),
        self_update_supported: server_self_update_supported(),
        capability: runtime::capability(),
        runtime: runtime::runtime_label().to_string(),
        restart_delay_ms: runtime::restart_delay_ms(),
        rollback_available: server_rollback_available(),
        live_progress: true,
        self_update_blocker: server_self_update_blocker(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_carries_the_blocker_in_the_shape_the_ui_reads() {
        // `selfUpdateBlocker` and the snake_case error fields inside it are what
        // `getServerUpdateStatus` consumers parse; a rename here would silently
        // bring back the doomed "Upgrade" button.
        let blocker = AppCommandError::permission_denied(
            "Update target is not writable: /usr/local/bin",
        )
        .with_i18n(
            "SystemSettings.updateErrors.permissionDenied",
            std::collections::BTreeMap::from([(
                "path".to_string(),
                "/usr/local/bin".to_string(),
            )]),
        );
        let status = ServerUpdateStatus {
            current_version: "0.32.0".to_string(),
            self_update_supported: true,
            capability: crate::update::runtime::UpdateCapability::Supervised,
            runtime: "standalone".to_string(),
            restart_delay_ms: 2000,
            rollback_available: false,
            live_progress: true,
            self_update_blocker: Some(blocker),
        };

        let wire = serde_json::to_value(&status).unwrap();
        let blocker = &wire["selfUpdateBlocker"];
        assert_eq!(blocker["code"], "permission_denied");
        assert_eq!(
            blocker["i18n_key"],
            "SystemSettings.updateErrors.permissionDenied"
        );
        assert_eq!(blocker["i18n_params"]["path"], "/usr/local/bin");

        // Nothing in the way: the field is absent, as on older servers.
        let clear = ServerUpdateStatus {
            self_update_blocker: None,
            ..status
        };
        assert!(serde_json::to_value(&clear)
            .unwrap()
            .get("selfUpdateBlocker")
            .is_none());
    }
}
