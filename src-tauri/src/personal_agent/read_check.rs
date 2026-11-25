//! Reads that must not pass a failure off as "nothing" (C1): the activity
//! read lists what waits on the owner, and a query that failed is not an
//! empty group — the page keeps what it had instead. The readings it is
//! made of go on as they always did (a failed query reads as none, for the
//! brief, the tools), and note the failure where a caller is checking:
//! [`checked`] runs a read and says whether any of it failed.

use std::cell::RefCell;
use std::future::Future;

tokio::task_local! {
    static FAILED: RefCell<Option<String>>;
}

/// The first failure noted by the read [`checked`] runs, when one is.
pub(crate) fn note(error: String) {
    let _ = FAILED.try_with(|f| {
        f.borrow_mut().get_or_insert(error);
    });
}

/// A reading's value, its default when it failed — noted for the read
/// being checked, if one is.
pub trait OrFailed<T> {
    fn or_failed(self) -> T;
}

impl<T: Default, E: std::fmt::Display> OrFailed<T> for Result<T, E> {
    fn or_failed(self) -> T {
        match self {
            Ok(v) => v,
            Err(e) => {
                note(e.to_string());
                T::default()
            }
        }
    }
}

/// A row looked up by a reading that calls its absence an error
/// (`NotFound`): `None` then, as when the reading failed — which is noted.
pub fn found<T>(r: Result<T, crate::db::error::DbError>) -> Option<T> {
    match r {
        Ok(v) => Some(v),
        Err(crate::db::error::DbError::NotFound(_)) => None,
        Err(e) => {
            note(e.to_string());
            None
        }
    }
}

/// Run `read`, and say whether any reading in it failed (the first
/// failure). It must read in this task: one spawned off is not checked.
pub async fn checked<F: Future>(read: F) -> (F::Output, Option<String>) {
    FAILED
        .scope(RefCell::new(None), async {
            let out = read.await;
            let failed = FAILED.with(|f| f.borrow_mut().take());
            (out, failed)
        })
        .await
}

/// The database as of one moment, to read from (C1): a connection of its
/// own in a read transaction — SQLite's WAL keeps what it reads as it was
/// when it began, whatever is written meanwhile; what writes waits on
/// nothing. An in-memory database (tests) shares its tables' locks across
/// connections, so a writer would fail rather than wait: it is read as it
/// is.
pub struct Snapshot {
    db: crate::db::AppDatabase,
    own: bool,
}

impl Snapshot {
    pub async fn of(db: &crate::db::AppDatabase) -> Result<Self, String> {
        use sea_orm::ConnectionTrait;
        let opts = db.conn.get_sqlite_connection_pool().connect_options();
        let name = opts.get_filename().to_string_lossy().into_owned();
        if name.starts_with("file:sqlx-in-memory-") || name == ":memory:" {
            return Ok(Self {
                db: crate::db::AppDatabase {
                    conn: db.conn.clone(),
                },
                own: false,
            });
        }
        let pool = sea_orm::sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .min_connections(1)
            .connect_with((*opts).clone())
            .await
            .map_err(|e| e.to_string())?;
        let conn = sea_orm::SqlxSqliteConnector::from_sqlx_sqlite_pool(pool);
        // The read transaction's moment is its first read.
        conn.execute_unprepared(
            "PRAGMA busy_timeout=5000; BEGIN; SELECT count(*) FROM sqlite_master;",
        )
        .await
        .map_err(|e| e.to_string())?;
        Ok(Self {
            db: crate::db::AppDatabase { conn },
            own: true,
        })
    }

    /// What to read from.
    pub fn db(&self) -> &crate::db::AppDatabase {
        &self.db
    }

    /// Done reading: its transaction ended, its connection closed.
    pub async fn finish(self) {
        use sea_orm::ConnectionTrait;
        if self.own {
            let _ = self.db.conn.execute_unprepared("ROLLBACK;").await;
            let _ = self.db.conn.close().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What is written while a snapshot is read is not in it; the next one
    /// has it.
    #[tokio::test]
    async fn a_snapshot_reads_the_database_as_it_was_when_it_began() {
        use sea_orm::{ConnectionTrait, DbBackend, Statement};
        let tmp = tempfile::tempdir().unwrap();
        let db = crate::db::test_helpers::fresh_disk_db(tmp.path()).await;
        let count = |db: &crate::db::AppDatabase| {
            let conn = db.conn.clone();
            async move {
                conn.query_one(Statement::from_string(
                    DbBackend::Sqlite,
                    "SELECT count(*) AS n FROM folder".to_owned(),
                ))
                .await
                .unwrap()
                .unwrap()
                .try_get::<i64>("", "n")
                .unwrap()
            }
        };
        crate::db::test_helpers::seed_folder(&db, "/a").await;
        let snap = Snapshot::of(&db).await.unwrap();
        assert_eq!(count(snap.db()).await, 1);
        // Written meanwhile, and not waiting on the reader.
        crate::db::test_helpers::seed_folder(&db, "/b").await;
        assert_eq!(count(&db).await, 2);
        assert_eq!(count(snap.db()).await, 1, "as it was");
        snap.finish().await;
        let next = Snapshot::of(&db).await.unwrap();
        assert_eq!(count(next.db()).await, 2);
        next.finish().await;
    }

    #[tokio::test]
    async fn a_failure_is_noted_only_where_a_read_is_checked() {
        let bad: Result<Vec<i32>, String> = Err("disk I/O error".into());
        assert!(
            bad.clone().or_failed().is_empty(),
            "unchecked: none, as always"
        );
        let ((), failed) = checked(async {
            let ok: Result<Vec<i32>, String> = Ok(vec![1]);
            assert_eq!(ok.or_failed(), vec![1]);
            assert!(bad.clone().or_failed().is_empty());
            let _ = Err::<Vec<i32>, _>("second".to_string()).or_failed();
        })
        .await;
        assert_eq!(
            failed.as_deref(),
            Some("disk I/O error"),
            "the first failure"
        );
        let ((), clean) = checked(async {}).await;
        assert!(clean.is_none());
    }
}
