//! Indexes the personal agent's "done today" reads by: an assistant's lines
//! of a kind since a time (`event`: the panel's acts that can still be
//! taken back), a message's replies (`message.reply_to`), and the work a
//! conversation ran (`dispatch.connection_id`).
//!
//! `IF NOT EXISTS`, so running it again changes nothing.

use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::TransactionTrait;

#[derive(DeriveMigrationName)]
pub struct Migration;

/// `(name, table, columns)`.
const INDEXES: &[(&str, &str, &str)] = &[
    (
        "idx_personal_agent_event_bot_kind_created",
        "personal_agent_event",
        r#""bot_id", "kind", "created_at""#,
    ),
    (
        "idx_personal_agent_message_reply_to",
        "personal_agent_message",
        r#""reply_to""#,
    ),
    (
        "idx_personal_agent_dispatch_connection",
        "personal_agent_dispatch",
        r#""connection_id""#,
    ),
];

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let txn = manager.get_connection().begin().await?;
        for (name, table, columns) in INDEXES {
            txn.execute_unprepared(&format!(
                r#"CREATE INDEX IF NOT EXISTS "{name}" ON "{table}" ({columns})"#
            ))
            .await?;
        }
        txn.commit().await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let conn = manager.get_connection();
        for (name, _, _) in INDEXES.iter().rev() {
            conn.execute_unprepared(&format!(r#"DROP INDEX IF EXISTS "{name}""#))
                .await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use sea_orm::{ConnectionTrait, Database, DbBackend, Statement};
    use sea_orm_migration::{MigratorTrait, SchemaManager};

    use crate::db::migration::Migrator;

    async fn indexes(conn: &sea_orm::DatabaseConnection) -> usize {
        conn.query_all(Statement::from_string(
            DbBackend::Sqlite,
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN \
             ('idx_personal_agent_event_bot_kind_created', \
              'idx_personal_agent_message_reply_to', \
              'idx_personal_agent_dispatch_connection')"
                .to_owned(),
        ))
        .await
        .expect("indexes")
        .len()
    }

    /// From the step before it: the three indexes are there; taken down and
    /// run again, they are there again.
    #[tokio::test]
    async fn adds_the_indexes_and_takes_them_down() {
        let conn = Database::connect("sqlite::memory:").await.expect("db");
        // A database whose history ends at the step before.
        let before = u32::try_from(<Migrator as MigratorTrait>::migrations().len() - 1).unwrap();
        Migrator::up(&conn, Some(before)).await.expect("migrate to 000002");
        assert_eq!(indexes(&conn).await, 0);
        Migrator::up(&conn, None).await.expect("upgrade");
        assert_eq!(indexes(&conn).await, 3);
        let this = <Migrator as MigratorTrait>::migrations()
            .into_iter()
            .find(|m| m.name() == "m20261125_000003_personal_agent_indexes")
            .expect("listed");
        let manager = SchemaManager::new(&conn);
        this.down(&manager).await.expect("down");
        assert_eq!(indexes(&conn).await, 0);
        this.up(&manager).await.expect("up again");
        this.up(&manager).await.expect("and once more");
        assert_eq!(indexes(&conn).await, 3);
    }
}
