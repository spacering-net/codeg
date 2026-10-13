//! Which git remote each folder's forge panel reads.
//!
//! **Not a field of [`ForgePanelSettings`](super::settings::ForgePanelSettings)**,
//! and not one shared JSON blob either. Each folder owns one metadata key:
//! `forge_panel_remote:<folder_id>`.
//!
//! That shape is deliberate. The picker can be used from more than one window,
//! and the database pool has multiple connections. A shared read-modify-write
//! blob lets two saves race:
//!
//! 1. window A reads the map,
//! 2. window B reads the same map,
//! 3. A writes folder 1,
//! 4. B writes folder 2 from its stale copy and silently drops folder 1.
//!
//! Per-folder keys remove that race entirely: unrelated folders never rewrite
//! one another. A folder with no key reads the historical `origin`; absence is
//! the default answer.
//!
//! The public API still returns a [`ForgeRemoteStore`] containing every saved
//! folder so the frontend can switch folders without another round trip. That
//! store is assembled from independent rows at read time; it is not persisted
//! as one value.

use std::collections::BTreeMap;

use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};
use serde::{Deserialize, Serialize};

use crate::db::entities::app_metadata;
use crate::db::error::DbError;
use crate::db::service::app_metadata_service;

/// Prefix for one folder's selection. The suffix is the decimal folder id.
const REMOTE_KEY_PREFIX: &str = "forge_panel_remote:";

/// Every folder's selection at once, as exposed to the frontend.
///
/// Persistence is per-folder even though the wire shape is aggregated.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForgeRemoteStore {
    #[serde(default)]
    pub folders: BTreeMap<i32, String>,
}

impl ForgeRemoteStore {
    /// The name this folder is set to, or `None` for the default.
    pub fn selected(&self, folder_id: i32) -> Option<&str> {
        self.folders.get(&folder_id).map(String::as_str)
    }
}

fn remote_key(folder_id: i32) -> String {
    format!("{REMOTE_KEY_PREFIX}{folder_id}")
}

fn parse_folder_id(key: &str) -> Option<i32> {
    key.strip_prefix(REMOTE_KEY_PREFIX)?.parse().ok()
}

fn trim(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Read every saved folder selection.
///
/// Each row is independent in storage; this aggregation exists only for the
/// frontend's "load once, switch folders locally" API.
pub async fn load(conn: &DatabaseConnection) -> Result<ForgeRemoteStore, DbError> {
    let rows = app_metadata::Entity::find()
        .filter(app_metadata::Column::Key.starts_with(REMOTE_KEY_PREFIX))
        .filter(app_metadata::Column::DeletedAt.is_null())
        .all(conn)
        .await?;

    let mut folders = BTreeMap::new();
    for row in rows {
        let Some(folder_id) = parse_folder_id(&row.key) else {
            continue;
        };
        let Some(remote) = trim(Some(row.value)) else {
            continue;
        };
        folders.insert(folder_id, remote);
    }

    Ok(ForgeRemoteStore { folders })
}

/// Read one folder directly from its own key — the hot path used by every forge
/// operation. No shared store is read or rewritten.
pub async fn load_selected(
    conn: &DatabaseConnection,
    folder_id: i32,
) -> Result<Option<String>, DbError> {
    let raw = app_metadata_service::get_value(conn, &remote_key(folder_id)).await?;
    Ok(trim(raw))
}

/// Save exactly one folder's selection and return the aggregated frontend view.
///
/// A blank or absent name clears the key, putting the folder back on the
/// historical `origin` default. Different folder ids touch different database
/// rows, so concurrent saves cannot overwrite one another.
pub async fn save(
    conn: &DatabaseConnection,
    folder_id: i32,
    remote: Option<String>,
) -> Result<ForgeRemoteStore, DbError> {
    let key = remote_key(folder_id);
    match trim(remote) {
        Some(name) => app_metadata_service::upsert_value(conn, &key, &name).await?,
        None => {
            app_metadata::Entity::delete_many()
                .filter(app_metadata::Column::Key.eq(key))
                .exec(conn)
                .await?;
        }
    }
    load(conn).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A folder with no key is on the default, not on a stored empty string the
    /// resolver would have to special-case.
    #[tokio::test]
    async fn an_untouched_folder_has_no_selection_of_its_own() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        assert_eq!(load_selected(&db.conn, 1).await.expect("read"), None);
        assert_eq!(load(&db.conn).await.expect("store"), ForgeRemoteStore::default());
    }

    /// One folder's value is trimmed on write; blank and absent values clear the
    /// key so the resolver goes back to `origin`.
    #[tokio::test]
    async fn saving_trims_the_name_and_clearing_removes_the_key() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;

        save(&db.conn, 1, Some("  upstream  ".into()))
            .await
            .expect("save");
        assert_eq!(
            load_selected(&db.conn, 1).await.expect("selected").as_deref(),
            Some("upstream")
        );

        save(&db.conn, 1, Some("   ".into()))
            .await
            .expect("blank clears");
        assert_eq!(load_selected(&db.conn, 1).await.expect("selected"), None);

        save(&db.conn, 1, Some("upstream".into()))
            .await
            .expect("save again");
        save(&db.conn, 1, None).await.expect("clear");
        assert_eq!(load_selected(&db.conn, 1).await.expect("selected"), None);
    }

    /// The frontend still receives every folder at once even though persistence
    /// is one key per folder.
    #[tokio::test]
    async fn load_aggregates_the_independent_folder_keys() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;

        save(&db.conn, 3, Some("upstream".into()))
            .await
            .expect("folder 3");
        save(&db.conn, 4, Some("backup".into()))
            .await
            .expect("folder 4");

        let store = load(&db.conn).await.expect("reload");
        assert_eq!(store.selected(3), Some("upstream"));
        assert_eq!(store.selected(4), Some("backup"));
        assert_eq!(store.selected(5), None);
    }

    /// This is the race the shared JSON blob could not make safe: two windows
    /// save different folders at the same time. With per-folder keys each write
    /// targets a different row, so neither can erase the other.
    #[tokio::test]
    async fn concurrent_saves_to_different_folders_cannot_overwrite_each_other() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;

        let (left, right) = tokio::join!(
            save(&db.conn, 3, Some("upstream".into())),
            save(&db.conn, 4, Some("backup".into()))
        );
        left.expect("folder 3 save");
        right.expect("folder 4 save");

        let store = load(&db.conn).await.expect("reload");
        assert_eq!(store.selected(3), Some("upstream"));
        assert_eq!(store.selected(4), Some("backup"));
    }

    /// Clearing one folder deletes only that folder's row.
    #[tokio::test]
    async fn clearing_one_folder_leaves_the_others_untouched() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;

        save(&db.conn, 3, Some("upstream".into()))
            .await
            .expect("folder 3");
        save(&db.conn, 4, Some("backup".into()))
            .await
            .expect("folder 4");

        save(&db.conn, 3, None).await.expect("clear folder 3");
        let store = load(&db.conn).await.expect("reload");
        assert_eq!(store.selected(3), None);
        assert_eq!(store.selected(4), Some("backup"));
    }

    /// Malformed keys or blank values are ignored when building the aggregate
    /// store; one bad metadata row must not break every forge panel.
    #[tokio::test]
    async fn malformed_rows_do_not_break_the_store() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;

        app_metadata_service::upsert_value(
            &db.conn,
            &format!("{REMOTE_KEY_PREFIX}not-an-id"),
            "upstream",
        )
        .await
        .expect("malformed id");
        app_metadata_service::upsert_value(
            &db.conn,
            &format!("{REMOTE_KEY_PREFIX}7"),
            "   ",
        )
        .await
        .expect("blank value");
        app_metadata_service::upsert_value(
            &db.conn,
            &format!("{REMOTE_KEY_PREFIX}8"),
            " backup ",
        )
        .await
        .expect("valid value");

        let store = load(&db.conn).await.expect("load");
        assert_eq!(store.selected(7), None);
        assert_eq!(store.selected(8), Some("backup"));
    }

    /// The aggregated wire shape still serializes folder ids as JSON object
    /// keys, which is what the TypeScript `Record<string, string>` consumes.
    #[test]
    fn folder_keys_survive_the_json_round_trip() {
        let store = ForgeRemoteStore {
            folders: [(42, "upstream".to_string())].into_iter().collect(),
        };
        let encoded = serde_json::to_string(&store).expect("serializable");
        assert!(encoded.contains("\"42\""), "{encoded}");
        assert_eq!(
            serde_json::from_str::<ForgeRemoteStore>(&encoded).expect("decodes"),
            store
        );
    }
}
