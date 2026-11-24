//! The webview's appearance settings as a snapshot domain.
//!
//! Theme colour, fonts, zoom, chat width, background display settings, the
//! custom theme and custom CSS all live in the webview's `localStorage` — the
//! pre-paint script reads them there before React exists, which is why they
//! cannot simply move into the database. The backend cannot read
//! `localStorage`, so the frontend MIRRORS the synced keys into one
//! `app_metadata` row ([`APPEARANCE_MIRROR_KEY`]) whenever they change, and the
//! `appearance` domain carries that row.
//!
//! Applying a snapshot writes the row, but the row is only a mirror: nothing
//! reads it at launch, and the next mirror write would put this machine's old
//! values straight back. So the applied values are also handed back to the
//! client that ran the restore/import/rollback ([`appearance_to_adopt`] →
//! `ApplyReport::appearance`), which writes them into its `localStorage`.
//! Handed back, not broadcast: in server mode every browser has its own
//! `localStorage`, and one user's restore must not restyle everybody else's.
//!
//! What is NOT here, on purpose: the background image file itself (a file on
//! disk, up to tens of MB), its cache-busting version stamp and wallpaper-market
//! source page (both meaningless without that file), and the custom-style
//! escape hatch (a per-machine safety switch, never a preference).

use std::collections::BTreeMap;

use futures::future::BoxFuture;
use sea_orm::{DatabaseConnection, DatabaseTransaction};
use serde_json::{Map, Value};

use super::domains::{DomainApplied, DOMAIN_APPEARANCE, DOMAIN_PREFERENCES};
use super::snapshot::ConfigSnapshot;
use crate::app_error::AppCommandError;
use crate::db::service::app_metadata_service;

/// Device-local `app_metadata` row holding the mirrored values as a JSON object.
/// Not in `portable_keys`: it travels as its own domain, never as a preference.
pub const APPEARANCE_MIRROR_KEY: &str = "appearance_web_settings";

/// The `localStorage` keys that travel. An allowlist for the same reason
/// `portable_keys` is one: a key added by a future feature stays on its machine
/// until somebody decides it should not. Must match
/// `SYNCED_APPEARANCE_KEYS` in `src/lib/appearance-sync.ts` (a frontend test
/// holds the two together).
pub const APPEARANCE_STORAGE_KEYS: &[&str] = &[
    // next-themes' light / dark / system choice.
    "theme",
    "codeg-theme-color",
    "codeg-zoom-level",
    "codeg-welcome-quick-actions",
    "codeg-chat-animations",
    "codeg-chat-content-width",
    "codeg-ui-font",
    "codeg-ui-font-custom",
    "codeg-ui-font-stack",
    "codeg-editor-font",
    "codeg-editor-font-custom",
    "codeg-editor-font-size",
    "codeg-editor-ligatures",
    "codeg-editor-word-wrap",
    "codeg-terminal-font",
    "codeg-terminal-font-custom",
    "codeg-terminal-font-size",
    "codeg-terminal-ligatures",
    "codeg-workspace-bg-enabled",
    "codeg-workspace-bg-mask",
    "codeg-workspace-bg-blur",
    "codeg-workspace-bg-fill",
    "codeg-workspace-bg-panel-opacity",
    "codeg-custom-theme",
    "codeg-custom-theme-enabled",
    "codeg-custom-css",
    "codeg-custom-css-enabled",
];

/// Per value. The largest legitimate one is custom CSS, which the frontend
/// caps at 64 KiB; double that leaves room for a future bump without letting a
/// doctored snapshot park megabytes in the database.
const MAX_VALUE_BYTES: usize = 128 * 1024;

/// `localStorage` key → stored string, as the frontend sends and receives it.
pub type AppearanceValues = BTreeMap<String, String>;

pub fn is_synced_appearance_key(key: &str) -> bool {
    APPEARANCE_STORAGE_KEYS.contains(&key)
}

fn accept(key: &str, value: &str) -> bool {
    is_synced_appearance_key(key) && value.len() <= MAX_VALUE_BYTES
}

/// The allowlisted, size-capped subset — applied on every way IN (a mirror
/// write from the frontend, a snapshot from a file or a share).
fn sanitize_values(values: AppearanceValues) -> AppearanceValues {
    values
        .into_iter()
        .filter(|(key, value)| accept(key, value))
        .collect()
}

fn sanitize_object(map: &Map<String, Value>) -> AppearanceValues {
    map.iter()
        .filter_map(|(key, value)| {
            let text = value.as_str()?;
            accept(key, text).then(|| (key.clone(), text.to_string()))
        })
        .collect()
}

fn db_err(err: crate::db::error::DbError) -> AppCommandError {
    AppCommandError::db(err)
}

/// Never fails: an unreadable row is an empty mirror, the same as none.
async fn read_mirror<C: sea_orm::ConnectionTrait>(conn: &C) -> AppearanceValues {
    match app_metadata_service::get_value_conn(conn, APPEARANCE_MIRROR_KEY).await {
        Ok(Some(raw)) => serde_json::from_str::<Map<String, Value>>(&raw)
            .map(|map| sanitize_object(&map))
            .unwrap_or_default(),
        _ => AppearanceValues::new(),
    }
}

async fn write_mirror<C: sea_orm::ConnectionTrait>(
    conn: &C,
    values: &AppearanceValues,
) -> Result<(), AppCommandError> {
    let serialized = serde_json::to_string(values).map_err(|e| {
        AppCommandError::task_execution_failed("Serialize appearance settings")
            .with_detail(e.to_string())
    })?;
    app_metadata_service::upsert_value(conn, APPEARANCE_MIRROR_KEY, &serialized)
        .await
        .map_err(db_err)
}

/// Replace the mirror with what the frontend currently holds. Wholesale, not a
/// merge: the mirror is the client's present state, and a key the client no
/// longer stores (reset to its default) must stop travelling.
///
/// Skips the write when nothing changed. Every window mirrors on launch, and
/// the row's `updated_at` churning would be noise at best.
pub async fn mirror_appearance_core(
    conn: &DatabaseConnection,
    values: AppearanceValues,
) -> Result<(), AppCommandError> {
    let values = sanitize_values(values);
    if read_mirror(conn).await == values {
        return Ok(());
    }
    write_mirror(conn, &values).await
}

// ─── the snapshot domain ──────────────────────────────────────────────

pub fn collect_appearance(
    conn: &DatabaseConnection,
) -> BoxFuture<'_, Result<Value, AppCommandError>> {
    Box::pin(async move {
        let values = read_mirror(conn).await;
        Ok(Value::Object(
            values
                .into_iter()
                .map(|(key, value)| (key, Value::String(value)))
                .collect(),
        ))
    })
}

pub fn validate_appearance(value: &Value) -> Result<(), AppCommandError> {
    match value {
        Value::Null | Value::Object(_) => Ok(()),
        _ => Err(AppCommandError::invalid_input(format!(
            "Snapshot domain '{DOMAIN_APPEARANCE}' is malformed"
        ))),
    }
}

pub fn count_appearance(value: &Value) -> usize {
    value
        .as_object()
        .map_or(0, |map| sanitize_object(map).len())
}

/// Additive, like every other domain: keys the snapshot does not mention keep
/// this machine's value.
pub fn apply_appearance<'a>(
    tx: &'a DatabaseTransaction,
    value: &'a Value,
) -> BoxFuture<'a, Result<DomainApplied, AppCommandError>> {
    Box::pin(async move {
        // The same verdict `validate_appearance` gives at preview time.
        validate_appearance(value)?;
        let Some(map) = value.as_object() else {
            return Ok(DomainApplied::default());
        };
        let incoming = sanitize_object(map);
        if incoming.is_empty() {
            return Ok(DomainApplied::default());
        }
        let written = incoming.len();
        let mut merged = read_mirror(tx).await;
        merged.extend(incoming);
        write_mirror(tx, &merged).await?;
        Ok(written.into())
    })
}

/// The `localStorage` values the client that applied `snapshot` should adopt.
///
/// A snapshot from a build before the `appearance` domain still carries light /
/// dark mode and zoom as the `appearance_mode` / `appearance_zoom_level`
/// preferences — mirrors that, until now, nothing ever read back. They are
/// mapped onto their `localStorage` keys so restoring an older snapshot shows
/// them too; the `appearance` domain wins where both are present.
pub fn appearance_to_adopt(snapshot: &ConfigSnapshot) -> AppearanceValues {
    let mut values = snapshot
        .domains
        .get(DOMAIN_APPEARANCE)
        .and_then(Value::as_object)
        .map(sanitize_object)
        .unwrap_or_default();

    if let Some(preferences) = snapshot
        .domains
        .get(DOMAIN_PREFERENCES)
        .and_then(Value::as_object)
    {
        if let Some(mode) = preferences.get("appearance_mode").and_then(Value::as_str) {
            if matches!(mode, "system" | "dark" | "light") {
                values
                    .entry("theme".to_string())
                    .or_insert_with(|| mode.to_string());
            }
        }
        if let Some(zoom) = preferences
            .get("appearance_zoom_level")
            .and_then(Value::as_str)
        {
            if zoom.parse::<u32>().is_ok() {
                values
                    .entry("codeg-zoom-level".to_string())
                    .or_insert_with(|| zoom.to_string());
            }
        }
    }
    values
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::config_sync::snapshot::SCHEMA_VERSION;
    use crate::db::test_helpers::fresh_in_memory_db;

    fn values(pairs: &[(&str, &str)]) -> AppearanceValues {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[tokio::test]
    async fn the_mirror_keeps_only_allowlisted_keys_and_round_trips_into_a_snapshot() {
        let db = fresh_in_memory_db().await;
        mirror_appearance_core(
            &db.conn,
            values(&[
                ("codeg-theme-color", "yellow"),
                ("codeg-zoom-level", "125"),
                // Device-local: the image cache-buster and the escape hatch.
                ("codeg-workspace-bg-image-version", "1700000000000"),
                ("codeg-custom-style-suspended", "1"),
                ("someone-elses-key", "x"),
            ]),
        )
        .await
        .expect("mirror");

        let collected = collect_appearance(&db.conn).await.expect("collect");
        assert_eq!(
            collected,
            serde_json::json!({ "codeg-theme-color": "yellow", "codeg-zoom-level": "125" })
        );
        assert_eq!(count_appearance(&collected), 2);
    }

    #[tokio::test]
    async fn an_oversized_value_does_not_travel() {
        let db = fresh_in_memory_db().await;
        let huge = "a".repeat(MAX_VALUE_BYTES + 1);
        mirror_appearance_core(
            &db.conn,
            values(&[("codeg-custom-css", &huge), ("codeg-ui-font", "inter")]),
        )
        .await
        .expect("mirror");
        assert_eq!(
            read_mirror(&db.conn).await,
            values(&[("codeg-ui-font", "inter")])
        );
    }

    /// Wholesale on the way in from the client: a key it dropped (reset to
    /// default) must stop travelling.
    #[tokio::test]
    async fn a_mirror_write_replaces_rather_than_merges() {
        let db = fresh_in_memory_db().await;
        mirror_appearance_core(&db.conn, values(&[("codeg-ui-font", "inter")]))
            .await
            .expect("mirror");
        mirror_appearance_core(&db.conn, values(&[("codeg-theme-color", "red")]))
            .await
            .expect("mirror");
        assert_eq!(
            read_mirror(&db.conn).await,
            values(&[("codeg-theme-color", "red")])
        );
    }

    #[tokio::test]
    async fn applying_merges_and_counts_only_what_it_writes() {
        let db = fresh_in_memory_db().await;
        mirror_appearance_core(
            &db.conn,
            values(&[("codeg-ui-font", "inter"), ("codeg-theme-color", "red")]),
        )
        .await
        .expect("mirror");

        let incoming = serde_json::json!({
            "codeg-theme-color": "yellow",
            "codeg-zoom-level": "125",
            "codeg-custom-style-suspended": "1",
            "codeg-editor-font-size": 15,
        });
        assert_eq!(count_appearance(&incoming), 2);

        use sea_orm::TransactionTrait;
        let tx = db.conn.begin().await.expect("begin");
        let applied = apply_appearance(&tx, &incoming).await.expect("apply");
        tx.commit().await.expect("commit");
        assert_eq!(applied.written, 2);
        assert_eq!(
            read_mirror(&db.conn).await,
            values(&[
                ("codeg-theme-color", "yellow"),
                ("codeg-ui-font", "inter"),
                ("codeg-zoom-level", "125"),
            ])
        );
    }

    #[test]
    fn malformed_domains_are_refused_at_preview_time() {
        assert!(validate_appearance(&serde_json::json!(["theme"])).is_err());
        assert!(validate_appearance(&Value::Null).is_ok());
        assert!(validate_appearance(&serde_json::json!({})).is_ok());
    }

    #[test]
    fn older_snapshots_still_hand_back_mode_and_zoom() {
        let mut domains = BTreeMap::new();
        domains.insert(
            DOMAIN_PREFERENCES.to_string(),
            serde_json::json!({
                "appearance_mode": "dark",
                "appearance_zoom_level": "125",
                "system_language_settings": "{}",
            }),
        );
        let legacy = ConfigSnapshot {
            schema_version: SCHEMA_VERSION,
            domains: domains.clone(),
        };
        assert_eq!(
            appearance_to_adopt(&legacy),
            values(&[("codeg-zoom-level", "125"), ("theme", "dark")])
        );

        // The domain wins over the legacy mirrors; nonsense legacy values are
        // dropped rather than handed to the client.
        domains.insert(
            DOMAIN_PREFERENCES.to_string(),
            serde_json::json!({ "appearance_mode": "purple", "appearance_zoom_level": "125" }),
        );
        domains.insert(
            DOMAIN_APPEARANCE.to_string(),
            serde_json::json!({ "codeg-zoom-level": "150", "codeg-custom-style-suspended": "1" }),
        );
        let current = ConfigSnapshot {
            schema_version: SCHEMA_VERSION,
            domains,
        };
        assert_eq!(
            appearance_to_adopt(&current),
            values(&[("codeg-zoom-level", "150")])
        );
    }
}
