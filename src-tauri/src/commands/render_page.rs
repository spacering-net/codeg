//! Render-page settings persistence — the web/Tauri-shared surface for the
//! `render_page` feature toggle.
//!
//! One knob survives across restarts:
//!   * `render_page.enabled` — feature kill switch (**default true**). When on,
//!     `codeg-mcp` exposes the `render_page` tool so an agent can draw a
//!     self-contained HTML page inline in the chat, optionally blocking on an
//!     answer the user submits on it.
//!
//! Default-ON follows `ask_user_question`: the tool only surfaces when the
//! agent *explicitly* chooses to render, so it is far less intrusive than the
//! opt-in feedback / delegation groups and ships enabled. A user who never
//! wants rendered pages can turn it off in settings.
//!
//! On startup `apply_persisted_render_config` reads this key from
//! `app_metadata` and pushes it into the shared [`RenderPageRuntimeConfig`]
//! that MCP injection reads. On UI save, `set_render_page_settings_core`
//! writes the key and immediately re-applies — mirroring the question settings
//! flow exactly (`crate::commands::question`).

use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};

use crate::acp::render_page::{RenderPageConfig, RenderPageRuntimeConfig};
use crate::app_error::AppCommandError;
use crate::db::service::app_metadata_service;
use crate::web::event_bridge::{emit_event, EventEmitter, RENDER_PAGE_SETTINGS_CHANGED_EVENT};

pub const KEY_RENDER_PAGE_ENABLED: &str = "render_page.enabled";

/// On by default (`enabled: true`) — see the module docs for why this diverges
/// from the opt-in feedback/delegation features.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RenderPageSettings {
    pub enabled: bool,
}

impl Default for RenderPageSettings {
    fn default() -> Self {
        Self { enabled: true }
    }
}

impl RenderPageSettings {
    fn into_runtime_config(self) -> RenderPageConfig {
        RenderPageConfig {
            enabled: self.enabled,
        }
    }
}

/// Read the persisted key from `app_metadata`, falling back to the default
/// (enabled) for a missing or malformed value. Never errors hard — corrupt
/// persistence is treated as "no preference yet".
pub async fn load_render_page_settings(conn: &DatabaseConnection) -> RenderPageSettings {
    let mut settings = RenderPageSettings::default();
    if let Ok(Some(raw)) = app_metadata_service::get_value(conn, KEY_RENDER_PAGE_ENABLED).await {
        if let Ok(v) = raw.parse::<bool>() {
            settings.enabled = v;
        }
    }
    settings
}

/// Pull settings from the DB and push the resulting `RenderPageConfig` onto the
/// shared runtime handle. Idempotent — safe on startup, after settings save, or
/// after any external write to `app_metadata`.
pub async fn apply_persisted_render_config(
    conn: &DatabaseConnection,
    config: &RenderPageRuntimeConfig,
) {
    let settings = load_render_page_settings(conn).await;
    config.set(settings.into_runtime_config()).await;
}

/// Persist + apply + broadcast. Used by both the Tauri command and the HTTP
/// handler so the write + re-apply + notify chain lives in exactly one place.
/// The broadcast lets a conversation view (in another window / WS client)
/// converge on the new flag — a frontend-only signal would never cross windows.
pub async fn set_render_page_settings_core(
    conn: &DatabaseConnection,
    config: &RenderPageRuntimeConfig,
    emitter: &EventEmitter,
    desired: RenderPageSettings,
) -> Result<RenderPageSettings, AppCommandError> {
    app_metadata_service::upsert_value(conn, KEY_RENDER_PAGE_ENABLED, &desired.enabled.to_string())
        .await
        .map_err(AppCommandError::from)?;
    config.set(desired.clone().into_runtime_config()).await;
    emit_event(emitter, RENDER_PAGE_SETTINGS_CHANGED_EVENT, &desired);
    Ok(desired)
}

// -------- Tauri commands -----------------------------------------------------

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_render_page_settings(
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
) -> Result<RenderPageSettings, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        Ok(load_render_page_settings(&db.conn).await)
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn set_render_page_settings(
    #[cfg(feature = "tauri-runtime")] app: tauri::AppHandle,
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
    #[cfg(feature = "tauri-runtime")] config: tauri::State<'_, RenderPageRuntimeConfig>,
    settings: RenderPageSettings,
) -> Result<RenderPageSettings, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        let emitter = EventEmitter::Tauri(app);
        set_render_page_settings_core(&db.conn, &config, &emitter, settings).await
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        let _ = settings;
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn load_returns_default_enabled_when_unset() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let settings = load_render_page_settings(&db.conn).await;
        assert!(settings.enabled, "render_page defaults ON");
    }

    #[tokio::test]
    async fn set_then_load_round_trip_and_runtime_applied() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let config = RenderPageRuntimeConfig::new();
        let saved = set_render_page_settings_core(
            &db.conn,
            &config,
            &EventEmitter::Noop,
            RenderPageSettings { enabled: false },
        )
        .await
        .unwrap();
        assert!(!saved.enabled);

        let loaded = load_render_page_settings(&db.conn).await;
        assert!(!loaded.enabled);
        assert!(!config.is_enabled().await);
    }

    #[tokio::test]
    async fn apply_persisted_pushes_db_value_onto_runtime() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        app_metadata_service::upsert_value(&db.conn, KEY_RENDER_PAGE_ENABLED, "false")
            .await
            .unwrap();
        let config = RenderPageRuntimeConfig::new();
        // The persisted "false" must flip the runtime off despite the on-by-default.
        apply_persisted_render_config(&db.conn, &config).await;
        assert!(!config.is_enabled().await);
    }
}
