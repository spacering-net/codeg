//! The rows waiting on the owner they chose to ignore on the activity
//! panel ([`super::activity_view::dismiss_mark`]): each kept as the row
//! stood when it was ignored, so the same thing moving on shows again.
//! Every assistant's list reads the one set — a row is the same thing on
//! the primary's page and on its own assistant's. Kept in `app_metadata`;
//! a mark long ignored is let go, as its row is long gone by then.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Duration, Utc};
use sea_orm::{ConnectionTrait, DatabaseConnection};
use tokio::sync::Mutex;

use crate::db::error::DbError;
use crate::db::service::app_metadata_service;

const KEY: &str = "personal_agent.activity_dismissed";

/// How long a mark is kept after it was ignored.
const KEEP_DAYS: i64 = 30;
/// The most marks kept: the latest ignored stay.
const KEEP_MAX: usize = 500;

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

/// Ignore `mark` from now on; the old marks let go.
pub async fn dismiss(conn: &DatabaseConnection, mark: &str) -> Result<(), DbError> {
    let _guard = WRITE.lock().await;
    let now = Utc::now();
    let mut marks = parse(app_metadata_service::get_value(conn, KEY).await?);
    marks.insert(mark.to_string(), now);
    let value = serde_json::to_string(&kept(marks, now)).unwrap_or_default();
    app_metadata_service::upsert_value(conn, KEY, &value).await
}

/// The marks still kept at `now`: none older than [`KEEP_DAYS`], at most
/// [`KEEP_MAX`] of the latest.
fn kept(
    marks: HashMap<String, DateTime<Utc>>,
    now: DateTime<Utc>,
) -> HashMap<String, DateTime<Utc>> {
    let from = now - Duration::days(KEEP_DAYS);
    let mut fresh: Vec<_> = marks.into_iter().filter(|(_, at)| *at >= from).collect();
    fresh.sort_by_key(|(_, at)| std::cmp::Reverse(*at));
    fresh.truncate(KEEP_MAX);
    fresh.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_marks_and_the_overflow_are_let_go() {
        let now = Utc::now();
        let mut marks = HashMap::new();
        marks.insert("old@1".to_string(), now - Duration::days(KEEP_DAYS + 1));
        for i in 0..KEEP_MAX + 3 {
            marks.insert(format!("r:{i}@1"), now - Duration::seconds(i as i64));
        }
        let out = kept(marks, now);
        assert_eq!(out.len(), KEEP_MAX);
        assert!(!out.contains_key("old@1"));
        assert!(out.contains_key("r:0@1"));
        assert!(!out.contains_key(&format!("r:{}@1", KEEP_MAX + 2)));
    }

    #[test]
    fn an_unreadable_value_hides_nothing() {
        assert!(parse(Some("not json".into())).is_empty());
        assert!(parse(None).is_empty());
    }
}
