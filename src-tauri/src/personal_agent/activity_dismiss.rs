//! The rows waiting on the owner they chose to ignore on the activity
//! panel ([`super::activity_view::dismiss_mark`]): each kept as the row
//! stood when it was ignored, so the same thing moving on shows again.
//! Every assistant's list reads the one set — a row is the same thing on
//! the primary's page and on its own assistant's. Kept in `app_metadata`,
//! for good: an ignored row is out of sight until it moves on, however long
//! that takes. One mark per thing — ignoring it again, moved on, takes the
//! old mark's place — so the set grows only by the things ever ignored.

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

/// Ignore `mark` from now on, in place of any mark of the same thing.
pub async fn dismiss(conn: &DatabaseConnection, mark: &str) -> Result<(), DbError> {
    let _guard = WRITE.lock().await;
    let mut marks = parse(app_metadata_service::get_value(conn, KEY).await?);
    put(&mut marks, mark, Utc::now());
    let value = serde_json::to_string(&marks).unwrap_or_default();
    app_metadata_service::upsert_value(conn, KEY, &value).await
}

/// The thing a mark is of: all before its last `@`.
fn thing_of(mark: &str) -> &str {
    mark.rsplit_once('@').map_or(mark, |(thing, _)| thing)
}

/// `mark` in, at `at`, and the same thing's older mark out: once a thing
/// has moved on, its old mark can never match again.
fn put(marks: &mut HashMap<String, DateTime<Utc>>, mark: &str, at: DateTime<Utc>) {
    let thing = thing_of(mark);
    marks.retain(|kept, _| thing_of(kept) != thing);
    marks.insert(mark.to_string(), at);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_thing_keeps_one_mark_however_old() {
        let long_ago = Utc::now() - chrono::Duration::days(400);
        let mut marks = HashMap::new();
        put(&mut marks, "item:1@100", long_ago);
        put(&mut marks, "pr:7@200#checks_slow", long_ago);
        for i in 0..600 {
            put(&mut marks, &format!("dispatch:{i}@1"), Utc::now());
        }
        // Nothing let go for its age or for how many there are.
        assert_eq!(marks.len(), 602);
        assert!(marks.contains_key("item:1@100"));

        // Ignored again, moved on: the new mark takes the old one's place.
        put(&mut marks, "pr:7@200#read_failed:auth", Utc::now());
        assert!(!marks.contains_key("pr:7@200#checks_slow"));
        assert!(marks.contains_key("pr:7@200#read_failed:auth"));
        assert_eq!(marks.len(), 602);
        // A thing whose name has an `@` in it is still one thing.
        put(&mut marks, "msg:a@b@1", Utc::now());
        put(&mut marks, "msg:a@b@2", Utc::now());
        assert!(!marks.contains_key("msg:a@b@1"));
        assert!(marks.contains_key("msg:a@b@2"));
    }

    #[tokio::test]
    async fn an_ignored_mark_is_kept_for_good() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let long_ago = Utc::now() - chrono::Duration::days(400);
        let stored =
            serde_json::to_string(&HashMap::from([("item:1@100".to_string(), long_ago)])).unwrap();
        app_metadata_service::upsert_value(&db.conn, KEY, &stored)
            .await
            .unwrap();
        dismiss(&db.conn, "item:2@5").await.unwrap();
        let marks = load(&db.conn).await;
        assert!(marks.contains("item:1@100"), "{marks:?}");
        assert!(marks.contains("item:2@5"), "{marks:?}");
    }

    #[test]
    fn an_unreadable_value_hides_nothing() {
        assert!(parse(Some("not json".into())).is_empty());
        assert!(parse(None).is_empty());
    }
}
