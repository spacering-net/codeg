//! The rows waiting on the owner they chose to ignore on the activity
//! panel ([`super::activity_view::dismiss_mark`]): each kept as the row
//! stood when it was ignored, so the same thing moving on shows again.
//! Every assistant's list reads the one set — a row is the same thing on
//! the primary's page and on its own assistant's. Kept in `app_metadata`,
//! every one for good: an ignored row is out of sight until it moves on,
//! however long that takes, and a thing ignored again as it stands later
//! (say, a pull request that cannot be read) keeps the first mark too — back
//! where it was ignored first, it stays out of sight. Marks are only ever
//! added by the owner's own Ignore, a few dozen bytes each.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use sea_orm::{ConnectionTrait, DatabaseConnection};
use tokio::sync::Mutex;

use crate::db::error::DbError;
use crate::db::service::app_metadata_service;

const KEY: &str = "personal_agent.activity_dismissed";

/// One write at a time: two ignored at once both kept.
static WRITE: Mutex<()> = Mutex::const_new(());

fn parse(raw: Option<String>) -> HashMap<String, DateTime<Utc>> {
    raw.and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// The marks ignored. Unreadable, none: nothing is hidden by mistake.
pub async fn load<C: ConnectionTrait>(conn: &C) -> HashSet<String> {
    let raw = app_metadata_service::get_value_conn(conn, KEY)
        .await
        .ok()
        .flatten();
    parse(raw).into_keys().collect()
}

/// Ignore `mark` from now on, with every mark ignored before.
pub async fn dismiss(conn: &DatabaseConnection, mark: &str) -> Result<(), DbError> {
    let _guard = WRITE.lock().await;
    let mut marks = parse(app_metadata_service::get_value(conn, KEY).await?);
    marks.insert(mark.to_string(), Utc::now());
    let value = serde_json::to_string(&marks).unwrap_or_default();
    app_metadata_service::upsert_value(conn, KEY, &value).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every mark is kept: none let go for its age, and a thing ignored
    /// again as it stands later keeps its first mark beside the new one.
    #[tokio::test]
    async fn every_ignored_mark_is_kept_for_good() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let long_ago = Utc::now() - chrono::Duration::days(400);
        // Far more than any cap would keep, the oldest long ago.
        let mut stored: HashMap<String, DateTime<Utc>> = (0..600)
            .map(|i| (format!("dispatch:{i}@1"), Utc::now()))
            .collect();
        stored.insert("item:1@100".to_string(), long_ago);
        let stored = serde_json::to_string(&stored).unwrap();
        app_metadata_service::upsert_value(&db.conn, KEY, &stored)
            .await
            .unwrap();
        dismiss(&db.conn, "pr:7@200#checks_slow").await.unwrap();
        dismiss(&db.conn, "pr:7@200#read_failed:auth")
            .await
            .unwrap();
        let marks = load(&db.conn).await;
        assert_eq!(marks.len(), 603);
        for mark in [
            "item:1@100",
            "pr:7@200#checks_slow",
            "pr:7@200#read_failed:auth",
        ] {
            assert!(marks.contains(mark), "{mark}");
        }
    }

    #[test]
    fn an_unreadable_value_hides_nothing() {
        assert!(parse(Some("not json".into())).is_empty());
        assert!(parse(None).is_empty());
    }
}
