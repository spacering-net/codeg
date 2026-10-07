//! Live user-feedback settings persistence + the submit command surface.
//!
//! One knob survives across restarts:
//!   * `feedback.enabled` — feature kill switch (default false). When on,
//!     `codeg-mcp` exposes the `check_user_feedback` tool so an agent can pull
//!     mid-turn user notes; the conversation UI shows the "send a note" bar.
//!
//! On startup `apply_persisted_feedback_config` reads this key from
//! `app_metadata` and pushes it into the shared [`FeedbackRuntimeConfig`] that
//! MCP injection reads. On UI save, `set_feedback_settings_core` writes the key
//! and immediately re-applies — mirroring the delegation settings flow exactly
//! (`crate::commands::delegation`).
//!
//! Submitting a note is a live ACP operation (it targets a running connection),
//! so `submit_session_feedback` lives here too but delegates straight to
//! `ConnectionManager::submit_feedback`; the manager owns the turn-in-flight
//! gate and the broadcast.

use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};

use crate::acp::feedback::{FeedbackConfig, FeedbackRuntimeConfig};
use crate::app_error::AppCommandError;
use crate::db::service::app_metadata_service;
use crate::web::event_bridge::{emit_event, EventEmitter, FEEDBACK_SETTINGS_CHANGED_EVENT};

pub const KEY_FEEDBACK_ENABLED: &str = "feedback.enabled";

/// Off by default (`enabled: false`): enabling injects a new tool into every
/// agent and changes agent behavior, so it is opt-in (matching delegation).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct FeedbackSettings {
    pub enabled: bool,
}

impl FeedbackSettings {
    fn into_runtime_config(self) -> FeedbackConfig {
        FeedbackConfig {
            enabled: self.enabled,
        }
    }
}

/// Read the persisted key from `app_metadata`, falling back to the default for
/// a missing or malformed value. Never errors hard — corrupt persistence is
/// treated as "no preference yet" (matches `load_delegation_settings`).
pub async fn load_feedback_settings(conn: &DatabaseConnection) -> FeedbackSettings {
    let mut settings = FeedbackSettings::default();
    if let Ok(Some(raw)) = app_metadata_service::get_value(conn, KEY_FEEDBACK_ENABLED).await {
        if let Ok(v) = raw.parse::<bool>() {
            settings.enabled = v;
        }
    }
    settings
}

/// Pull settings from the DB and push the resulting `FeedbackConfig` onto the
/// shared runtime handle. Idempotent — safe on startup, after settings save, or
/// after any external write to `app_metadata`.
pub async fn apply_persisted_feedback_config(
    conn: &DatabaseConnection,
    config: &FeedbackRuntimeConfig,
) {
    let settings = load_feedback_settings(conn).await;
    config.set(settings.into_runtime_config()).await;
}

/// Persist + apply + broadcast. Used by both the Tauri command and the HTTP
/// handler so the write + re-apply + notify chain lives in exactly one place.
///
/// The broadcast is load-bearing, not cosmetic: the settings UI runs in a
/// separate window, so a conversation's feedback bar (in another window / WS
/// client) only learns the flag flipped via this backend
/// [`FEEDBACK_SETTINGS_CHANGED_EVENT`] side-channel — a frontend-only signal
/// would never cross the window boundary.
pub async fn set_feedback_settings_core(
    conn: &DatabaseConnection,
    config: &FeedbackRuntimeConfig,
    emitter: &EventEmitter,
    desired: FeedbackSettings,
) -> Result<FeedbackSettings, AppCommandError> {
    app_metadata_service::upsert_value(conn, KEY_FEEDBACK_ENABLED, &desired.enabled.to_string())
        .await
        .map_err(AppCommandError::from)?;
    config.set(desired.clone().into_runtime_config()).await;
    emit_event(emitter, FEEDBACK_SETTINGS_CHANGED_EVENT, &desired);
    Ok(desired)
}

// -------- Tauri commands -----------------------------------------------------

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_feedback_settings(
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
) -> Result<FeedbackSettings, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        Ok(load_feedback_settings(&db.conn).await)
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn set_feedback_settings(
    #[cfg(feature = "tauri-runtime")] app: tauri::AppHandle,
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
    #[cfg(feature = "tauri-runtime")] config: tauri::State<'_, FeedbackRuntimeConfig>,
    settings: FeedbackSettings,
) -> Result<FeedbackSettings, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        // Tauri's `app.emit` fans out to every window, so the feedback bar in an
        // open conversation window converges even though this save originates in
        // the separate settings window.
        let emitter = EventEmitter::Tauri(app);
        set_feedback_settings_core(&db.conn, &config, &emitter, settings).await
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        let _ = settings;
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

/// Submit a live-feedback note to a running connection. Tauri-only wrapper; the
/// web handler mirrors this. Returns the stored note so the caller can render it
/// optimistically (it also arrives via the `FeedbackSubmitted` event).
///
/// `blocks` (optional) is the full prompt-block draft when the note carries
/// image attachments; `text` stays the recorded/display form. Only the native
/// `_session/steering` channel can deliver blocks — the manager rejects them
/// on the pull path so an attachment is never silently dropped.
///
/// The gate lives in `ConnectionManager::submit_feedback`, keyed on the
/// connection's actual `check_user_feedback` capability (not the possibly
/// later-toggled global setting). Rejections the frontend recognizes:
/// `FeedbackDisabled` (this session has no feedback tool), `NoActiveTurn` (turn
/// ended → fall back to an ordinary prompt), `InvalidFeedback` (empty/oversized).
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn submit_session_feedback(
    connection_id: String,
    text: String,
    blocks: Option<Vec<crate::acp::types::PromptInputBlock>>,
    manager: tauri::State<'_, crate::acp::manager::ConnectionManager>,
) -> Result<crate::acp::feedback::FeedbackItem, crate::acp::error::AcpError> {
    manager.submit_feedback(&connection_id, text, blocks).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn load_returns_default_when_unset() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let settings = load_feedback_settings(&db.conn).await;
        assert!(!settings.enabled);
    }

    #[tokio::test]
    async fn set_then_load_round_trip_and_runtime_applied() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let config = FeedbackRuntimeConfig::new();
        let saved = set_feedback_settings_core(
            &db.conn,
            &config,
            &EventEmitter::Noop,
            FeedbackSettings { enabled: true },
        )
        .await
        .unwrap();
        assert!(saved.enabled);

        // Persisted + reloaded identically.
        let loaded = load_feedback_settings(&db.conn).await;
        assert!(loaded.enabled);

        // Runtime handle received the new value (MCP injection reads this).
        assert!(config.is_enabled().await);
    }

    #[tokio::test]
    async fn apply_persisted_pushes_db_value_onto_runtime() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        app_metadata_service::upsert_value(&db.conn, KEY_FEEDBACK_ENABLED, "true")
            .await
            .unwrap();
        let config = FeedbackRuntimeConfig::new();
        assert!(!config.is_enabled().await);
        apply_persisted_feedback_config(&db.conn, &config).await;
        assert!(config.is_enabled().await);
    }
}
