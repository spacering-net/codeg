use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::{ConnectionTrait, DbBackend, Statement};

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // Retro-fix for issue #495. A session launched from a task board card
        // was always SEEDED with the card's name, but the row was left
        // unlocked, so the per-turn auto-title backfill
        // (`conversation_service::refresh_auto_title`) replaced it with
        // whatever the agent's session file parsed to — for agents with no
        // title of their own, the first line of the composed prompt. The
        // sidebar ended up full of rows named `项目：/Users/…` that answer to
        // nothing on the board. The engine now locks the seed at launch; this
        // repairs the sessions that ran before it did.
        //
        // `title_locked = 0` is the safety gate, and it is exact rather than
        // heuristic here: `m20260608_000001` locked EVERY pre-existing titled
        // row when the flag was introduced, and the `work_task` table only
        // arrived in `m20260801_000001`, so for a task-launched session
        // `title_locked = 0` means precisely "the user never renamed this by
        // hand". A name they picked themselves is never touched.
        //
        // Limitation, by construction: only the session each card currently
        // points at can be repaired. A card whose resume failed left its
        // earlier conversation behind with no back-reference, so those rows
        // stay as they are.
        let conn = manager.get_connection();
        let sql = "UPDATE conversation \
               SET title = (SELECT substr(trim(wt.title), 1, 80) FROM work_task AS wt \
                             WHERE wt.conversation_id = conversation.id \
                             ORDER BY wt.id DESC LIMIT 1), \
                   title_locked = 1 \
             WHERE title_locked = 0 \
               AND deleted_at IS NULL \
               AND EXISTS (SELECT 1 FROM work_task AS wt \
                            WHERE wt.conversation_id = conversation.id \
                              AND trim(wt.title) <> '')";
        conn.execute(Statement::from_string(DbBackend::Sqlite, sql.to_string()))
            .await?;
        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        // Data-only and irreversible: the titles this overwrote were themselves
        // derived from the session files, and nothing recorded them. Rolling
        // back would mean inventing names. Re-opening a conversation after a
        // manual `title_locked` reset is the only way back, and that is a user
        // action, not a schema one.
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm_migration::sea_orm::{Database, DbBackend, Statement};

    /// Drive `up` against minimal stand-ins of the two tables and assert the
    /// backfill touches exactly the sessions a card produced and never renamed
    /// by hand.
    #[tokio::test]
    async fn up_renames_only_unlocked_task_sessions() {
        let conn = Database::connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        conn.execute_unprepared(
            "CREATE TABLE conversation (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, \
             title_locked BOOLEAN NOT NULL DEFAULT 0, deleted_at TEXT)",
        )
        .await
        .expect("create conversation stub");
        conn.execute_unprepared(
            "CREATE TABLE work_task (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, \
             conversation_id INTEGER)",
        )
        .await
        .expect("create work_task stub");

        // 1: a task session the auto-title clobbered — the case being fixed.
        // 2: a task session the user renamed by hand — must not be touched.
        // 3: an ordinary conversation with no card behind it.
        // 4: a task session on a soft-deleted row — left alone.
        conn.execute_unprepared(
            "INSERT INTO conversation (title, title_locked, deleted_at) VALUES \
             ('项目：/Users/me/app', 0, NULL), \
             ('My own name', 1, NULL), \
             ('just a chat', 0, NULL), \
             ('项目：/Users/me/app', 0, '2026-08-01T00:00:00Z')",
        )
        .await
        .expect("insert conversations");
        conn.execute_unprepared(
            "INSERT INTO work_task (title, conversation_id) VALUES \
             ('  Fix the login flow  ', 1), ('Rename me', 2), ('Deleted one', 4)",
        )
        .await
        .expect("insert tasks");

        Migration
            .up(&SchemaManager::new(&conn))
            .await
            .expect("run migration up");

        let rows = conn
            .query_all(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT id, title, title_locked FROM conversation ORDER BY id".to_owned(),
            ))
            .await
            .expect("query rows");
        let got: Vec<(String, i32)> = rows
            .iter()
            .map(|r| {
                (
                    r.try_get::<String>("", "title").expect("title"),
                    r.try_get::<i32>("", "title_locked").expect("lock"),
                )
            })
            .collect();

        assert_eq!(
            got[0],
            ("Fix the login flow".to_string(), 1),
            "an unlocked task session must adopt its card's (trimmed) name and lock"
        );
        assert_eq!(
            got[1],
            ("My own name".to_string(), 1),
            "a hand-picked name must survive the backfill"
        );
        assert_eq!(
            got[2],
            ("just a chat".to_string(), 0),
            "a conversation with no card behind it must not be touched or locked"
        );
        assert_eq!(
            got[3],
            ("项目：/Users/me/app".to_string(), 0),
            "a soft-deleted row is out of scope"
        );
    }

    /// The cap must count CHARACTERS, not bytes — SQLite's `substr` does, which
    /// is what makes it agree with the engine's `conversation_title_for_task`.
    #[tokio::test]
    async fn up_caps_a_long_title_at_eighty_characters() {
        let conn = Database::connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        conn.execute_unprepared(
            "CREATE TABLE conversation (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, \
             title_locked BOOLEAN NOT NULL DEFAULT 0, deleted_at TEXT)",
        )
        .await
        .expect("create conversation stub");
        conn.execute_unprepared(
            "CREATE TABLE work_task (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, \
             conversation_id INTEGER)",
        )
        .await
        .expect("create work_task stub");

        let long: String = "标".repeat(100);
        conn.execute_unprepared("INSERT INTO conversation (title) VALUES ('stale')")
            .await
            .expect("insert conversation");
        conn.execute_unprepared(&format!(
            "INSERT INTO work_task (title, conversation_id) VALUES ('{long}', 1)"
        ))
        .await
        .expect("insert task");

        Migration
            .up(&SchemaManager::new(&conn))
            .await
            .expect("run migration up");

        let rows = conn
            .query_all(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT title FROM conversation WHERE id = 1".to_owned(),
            ))
            .await
            .expect("query row");
        let title: String = rows[0].try_get("", "title").expect("title");
        assert_eq!(
            title.chars().count(),
            80,
            "80 CHARACTERS, not bytes: {title}"
        );
    }
}
