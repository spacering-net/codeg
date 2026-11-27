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
    // GET must answer in the same shape PUT accepts: the client blob itself,
    // never the storage envelope. Handing back the raw row made every client
    // parse `{"prefs":"…","synced_at_ms":N}` as its own blob, find no keys,
    // conclude "server has nothing" and push its local copy — so the server
    // never seeded anyone and the reconciler diffed empty key maps.
    let (blob, synced_at_ms) = match stored {
        Some(raw) => {
            let ms = parse_synced_at(&raw).unwrap_or(0);
            (unwrap_prefs(&raw), ms)
        }
        None => (String::new(), 0),
    };
    Ok(Json(ClientPreferences {
        prefs: blob,
        synced_at_ms,
        supported: true,
    }))
}

pub async fn update_client_preferences(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UpdateClientPreferencesParams>,
) -> Result<Json<ClientPreferences>, AppCommandError> {
    // Normalise before storing: an older reconciler shipped a whole GET
    // response as the blob, which nests envelope inside envelope. Unwrapping
    // here means one bad write can never wedge the row permanently.
    let prefs = unwrap_prefs(&params.prefs);
    if prefs.len() > MAX_PREFS_BYTES {
        return Err(AppCommandError::invalid_input(format!(
            "prefs blob too large ({} > {} bytes)",
            prefs.len(),
            MAX_PREFS_BYTES
        )));
    }
    // Must parse as a JSON object — the reconciler diffs whole blobs and a
    // non-object would break its hash comparison.
    if serde_json::from_str::<serde_json::Value>(&prefs)
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
        "prefs": prefs,
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
        prefs,
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

/// Peel storage envelopes off a blob until the client's own object surfaces.
///
/// Two writers can produce nesting: the pre-fix reconciler imported a whole GET
/// response, and rows written before GET/PUT agreed on the shape hold
/// `{"prefs":"{\"prefs\":…}","synced_at_ms":N}`. The client blob is recognised
/// by its `keys` map — an envelope never has one — so anything carrying `keys`
/// is returned untouched and a genuinely unknown blob survives verbatim.
fn unwrap_prefs(blob: &str) -> String {
    // Bounded: each round trip through a buggy writer adds one level, and a
    // few levels of legacy nesting is all that can exist in practice.
    const MAX_DEPTH: usize = 8;
    let mut current = blob.to_string();
    for _ in 0..MAX_DEPTH {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&current) else {
            return current;
        };
        let Some(object) = value.as_object() else {
            return current;
        };
        if object.contains_key("keys") {
            return current;
        }
        let Some(inner) = object.get("prefs").and_then(|p| p.as_str()) else {
            return current;
        };
        current = inner.to_string();
    }
    current
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

    #[test]
    fn unwrap_prefs_returns_client_blob_untouched() {
        let blob = r#"{"keys":{"codeg-floating-ball-enabled":"1"},"syncedAtMs":7}"#;
        assert_eq!(unwrap_prefs(blob), blob);
        // A blob that is not an envelope is never rewritten.
        assert_eq!(unwrap_prefs("{}"), "{}");
        assert_eq!(unwrap_prefs(""), "");
        assert_eq!(unwrap_prefs("not json"), "not json");
    }

    #[test]
    fn unwrap_prefs_peels_nested_envelopes() {
        let blob = r#"{"keys":{"a":"1"},"syncedAtMs":7}"#;
        let once = serde_json::json!({"prefs": blob, "synced_at_ms": 7}).to_string();
        assert_eq!(unwrap_prefs(&once), blob);
        let twice = serde_json::json!({
            "prefs": once,
            "synced_at_ms": 7,
            "supported": true,
        })
        .to_string();
        assert_eq!(unwrap_prefs(&twice), blob);
    }

    #[test]
    fn get_response_shape_matches_put_input() {
        // Regression: GET used to hand back the storage row, so a client round
        // trip (GET → PUT the same string) buried the blob one level deeper on
        // every pass. After the fix the response's `prefs` is directly usable
        // as PUT's `prefs`, which is what the reconciler does.
        let blob = r#"{"keys":{"k":"v"},"syncedAtMs":11}"#;
        let stored = serde_json::json!({"prefs": blob, "synced_at_ms": 11}).to_string();
        let served = unwrap_prefs(&stored);
        assert_eq!(served, blob);
        let rewritten = serde_json::json!({"prefs": served, "synced_at_ms": 11}).to_string();
        assert_eq!(rewritten, stored);
    }
}
