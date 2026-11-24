//! Ask-user-question settings persistence — the web/Tauri-shared surface for
//! the `ask_user_question` feature toggle.
//!
//! One knob survives across restarts:
//!   * `question.enabled` — feature kill switch (**default true**). When on,
//!     `codeg-mcp` exposes the `ask_user_question` tool so an agent can block on
//!     a multiple-choice question rendered above the conversation input box.
//!
//! Default-ON deliberately diverges from live-feedback / delegation (both
//! default OFF). Those add a tool the agent polls / fans out unprompted, so they
//! are opt-in; `ask_user_question` only surfaces when the agent *explicitly*
//! pauses on a decision that is genuinely the user's, so it is far less
//! intrusive and ships enabled. A user who never wants the agent to ask can turn
//! it off in settings.
//!
//! On startup `apply_persisted_question_config` reads this key from
//! `app_metadata` and pushes it into the shared [`QuestionRuntimeConfig`] that
//! MCP injection reads. On UI save, `set_question_settings_core` writes the key
//! and immediately re-applies — mirroring the feedback settings flow exactly
//! (`crate::commands::feedback`).

use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};

use crate::acp::question::{QuestionConfig, QuestionRuntimeConfig};
use crate::app_error::AppCommandError;
use crate::db::service::app_metadata_service;
use crate::web::event_bridge::{emit_event, EventEmitter, QUESTION_SETTINGS_CHANGED_EVENT};

pub const KEY_QUESTION_ENABLED: &str = "question.enabled";

/// On by default (`enabled: true`) — see the module docs for why this diverges
/// from the opt-in feedback/delegation features.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct QuestionSettings {
    pub enabled: bool,
}

impl Default for QuestionSettings {
    fn default() -> Self {
        Self { enabled: true }
    }
}

impl QuestionSettings {
    fn into_runtime_config(self) -> QuestionConfig {
        QuestionConfig {
            enabled: self.enabled,
        }
    }
}

/// Read the persisted key from `app_metadata`, falling back to the default
/// (enabled) for a missing or malformed value. Never errors hard — corrupt
/// persistence is treated as "no preference yet".
pub async fn load_question_settings(conn: &DatabaseConnection) -> QuestionSettings {
    let mut settings = QuestionSettings::default();
    if let Ok(Some(raw)) = app_metadata_service::get_value(conn, KEY_QUESTION_ENABLED).await {
        if let Ok(v) = raw.parse::<bool>() {
            settings.enabled = v;
        }
    }
    settings
}

/// Pull settings from the DB and push the resulting `QuestionConfig` onto the
/// shared runtime handle. Idempotent — safe on startup, after settings save, or
/// after any external write to `app_metadata`.
pub async fn apply_persisted_question_config(
    conn: &DatabaseConnection,
    config: &QuestionRuntimeConfig,
) {
    let settings = load_question_settings(conn).await;
    config.set(settings.into_runtime_config()).await;
}

/// Persist + apply + broadcast. Used by both the Tauri command and the HTTP
/// handler so the write + re-apply + notify chain lives in exactly one place.
/// The broadcast lets a conversation view (in another window / WS client)
/// converge on the new flag — a frontend-only signal would never cross windows.
pub async fn set_question_settings_core(
    conn: &DatabaseConnection,
    config: &QuestionRuntimeConfig,
    emitter: &EventEmitter,
    desired: QuestionSettings,
) -> Result<QuestionSettings, AppCommandError> {
    app_metadata_service::upsert_value(conn, KEY_QUESTION_ENABLED, &desired.enabled.to_string())
        .await
        .map_err(AppCommandError::from)?;
    config.set(desired.clone().into_runtime_config()).await;
    emit_event(emitter, QUESTION_SETTINGS_CHANGED_EVENT, &desired);
    Ok(desired)
}

// -------- Tauri commands -----------------------------------------------------

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_question_settings(
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
) -> Result<QuestionSettings, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        Ok(load_question_settings(&db.conn).await)
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn set_question_settings(
    #[cfg(feature = "tauri-runtime")] app: tauri::AppHandle,
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
    #[cfg(feature = "tauri-runtime")] config: tauri::State<'_, QuestionRuntimeConfig>,
    settings: QuestionSettings,
) -> Result<QuestionSettings, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        let emitter = EventEmitter::from_app(&app);
        set_question_settings_core(&db.conn, &config, &emitter, settings).await
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
        let settings = load_question_settings(&db.conn).await;
        assert!(settings.enabled, "ask_user_question defaults ON");
    }

    #[tokio::test]
    async fn set_then_load_round_trip_and_runtime_applied() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let config = QuestionRuntimeConfig::new();
        let saved = set_question_settings_core(
            &db.conn,
            &config,
            &EventEmitter::Noop,
            QuestionSettings { enabled: false },
        )
        .await
        .unwrap();
        assert!(!saved.enabled);

        let loaded = load_question_settings(&db.conn).await;
        assert!(!loaded.enabled);
        assert!(!config.is_enabled().await);
    }

    #[tokio::test]
    async fn apply_persisted_pushes_db_value_onto_runtime() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        app_metadata_service::upsert_value(&db.conn, KEY_QUESTION_ENABLED, "false")
            .await
            .unwrap();
        let config = QuestionRuntimeConfig::new();
        // Default runtime is disabled; applying the persisted "false" keeps it off.
        apply_persisted_question_config(&db.conn, &config).await;
        assert!(!config.is_enabled().await);
    }
}
