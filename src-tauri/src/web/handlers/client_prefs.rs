//! Client-side preference blob storage (batch v91).
//!
//! The floating-ball settings (enabled/position/bindings/size/favorite
//! agents) live in the browser's localStorage, which is per-browser,
//! per-device: clearing site data or opening a new browser loses every
//! gesture binding, and each of the owner's three servers had to be
//! configured by hand. This handler stores the blob server-side (opaque JSON
//! in the existing `app_metadata` KV table — schema stays owned by the
//! frontend) so any web client can re-seed itself after hydration.
//!
//! Deliberately minimal: one GET, one PUT, no schema knowledge, no
//! cross-field validation. The three-server reconciler (codeg-prefs-sync.sh)
//! uses the same endpoints over loopback, so conflict resolution stays
//! outside the server.

use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;

/// KV key in `app_metadata`. Versioned so a future schema change can move to
/// `client_prefs.v2` without migrating the old blob.
pub const CLIENT_PREFS_KEY: &str = "client_prefs.v1";

/// Cap the blob: the floating-ball state is a few hundred bytes; 64KB gives
/// headroom for future client-side blocks without letting a bad client wedge
/// the DB with megabytes.
const MAX_PREFS_BYTES: usize = 64 * 1024;

#[derive(Deserialize)]
pub struct UpdateClientPreferencesParams {
    /// Opaque JSON string (the client serializes its own whitelist blocks)
    /// plus the wall-clock stamp used by the cross-server reconciler for
    /// last-write-wins ordering.
    pub prefs: String,
    #[serde(default)]
    pub synced_at_ms: u64,
}

#[derive(serde::Serialize)]
pub struct ClientPreferences {
    pub prefs: String,
    pub synced_at_ms: u64,
    /// False on a server that predates this handler — the frontend treats a
    /// missing endpoint as "no server-side memory" and skips silently.
    pub supported: bool,
}

pub async fn get_client_preferences(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<ClientPreferences>, AppCommandError> {
    let stored = crate::db::service::app_metadata_service::get_value(
        &state.db.conn,
        CLIENT_PREFS_KEY,
    )
    .await
    .map_err(AppCommandError::from)?;
    Ok(Json(ClientPreferences {
        prefs: stored.clone().unwrap_or_default(),
        synced_at_ms: stored.and_then(|s| parse_synced_at(&s)).unwrap_or(0),
        supported: true,
    }))
}

pub async fn update_client_preferences(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UpdateClientPreferencesParams>,
) -> Result<Json<ClientPreferences>, AppCommandError> {
    if params.prefs.len() > MAX_PREFS_BYTES {
        return Err(AppCommandError::invalid_input(format!(
            "prefs blob too large ({} > {} bytes)",
            params.prefs.len(),
            MAX_PREFS_BYTES
        )));
    }
    // Must parse as a JSON object — the reconciler diffs whole blobs and a
    // non-object would break its hash comparison.
    if serde_json::from_str::<serde_json::Value>(&params.prefs)
        .map(|v| !v.is_object())
        .unwrap_or(true)
    {
        return Err(AppCommandError::invalid_input(
            "prefs must be a JSON object string",
        ));
    }
    // synced_at_ms rides inside the blob so GET is a single read and the
    // reconciler's export needs no separate endpoint.
    let blob = serde_json::json!({
        "prefs": params.prefs,
        "synced_at_ms": params.synced_at_ms,
    });
    let serialized = blob.to_string();
    crate::db::service::app_metadata_service::upsert_value(
        &state.db.conn,
        CLIENT_PREFS_KEY,
        &serialized,
    )
    .await
    .map_err(AppCommandError::from)?;
    Ok(Json(ClientPreferences {
        prefs: params.prefs,
        synced_at_ms: params.synced_at_ms,
        supported: true,
    }))
}

/// The stamp is stored inside the JSON envelope; a blob that predates it (or
/// was written by a different tool) reads as 0.
fn parse_synced_at(envelope: &str) -> Option<u64> {
    let v: serde_json::Value = serde_json::from_str(envelope).ok()?;
    Some(v.get("synced_at_ms").and_then(|x| x.as_u64()).unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_synced_at_handles_envelope_and_legacy() {
        assert_eq!(
            parse_synced_at(r#"{"prefs":"{}","synced_at_ms":42}"#),
            Some(42)
        );
        assert_eq!(parse_synced_at(r#"{"prefs":"{}"}"#), Some(0));
        assert_eq!(parse_synced_at("not json"), None);
    }
}
