//! How each of an assistant's matters ended, and the owner's answer to a
//! question it asked: `closed_at`, `closed_by` (`owner` / `agent` /
//! `codeg`) and `closed_how`, stamped the moment a matter goes from open to
//! settled — what "done today" says of it — and `answer_row_id` /
//! `answer_state`, the owner's message answering a question and how it
//! stands (`linked` while the assistant has it, `interrupted` when the turn
//! that had it did not finish).
//!
//! A step of its own, after the personal agent's schema: that one had run on
//! databases before these columns were thought of. Safe to run again, like
//! it: one transaction, and a column is added only when `pragma_table_info`
//! does not list it yet.

use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::TransactionTrait;

use super::m20261125_000001_personal_agent::add_column;

#[derive(DeriveMigrationName)]
pub struct Migration;

const COLUMNS: &[(&str, &str)] = &[
    ("closed_at", "timestamp_with_timezone_text NULL"),
    ("closed_by", "text NULL"),
    ("closed_how", "text NULL"),
    ("answer_row_id", "integer NULL"),
    ("answer_state", "text NULL"),
];

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let txn = manager.get_connection().begin().await?;
        for (column, decl) in COLUMNS {
            add_column(&txn, "personal_agent_item", column, decl).await?;
        }
        txn.execute_unprepared(
            r#"CREATE INDEX IF NOT EXISTS "idx_personal_agent_item_closed_at" ON "personal_agent_item" ("bot_id", "closed_at")"#,
        )
        .await?;
        txn.commit().await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let conn = manager.get_connection();
        conn.execute_unprepared(r#"DROP INDEX IF EXISTS "idx_personal_agent_item_closed_at""#)
            .await?;
        for (column, _) in COLUMNS.iter().rev() {
            conn.execute_unprepared(&format!(
                "ALTER TABLE personal_agent_item DROP COLUMN {column}"
            ))
            .await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use sea_orm::{ConnectionTrait, Database, DbBackend, Statement};
    use sea_orm_migration::MigratorTrait;

    use crate::db::migration::Migrator;

    /// On a database the personal agent's schema ran on before these
    /// columns: they are added, and once more changes nothing.
    #[tokio::test]
    async fn adds_the_columns_once() {
        let conn = Database::connect("sqlite::memory:").await.expect("db");
        Migrator::up(&conn, None).await.expect("migrate");
        let again = <Migrator as MigratorTrait>::migrations()
            .into_iter()
            .find(|m| m.name() == "m20261125_000002_personal_agent_item_closure")
            .expect("listed");
        again
            .up(&sea_orm_migration::SchemaManager::new(&conn))
            .await
            .expect("second run");
        let cols = conn
            .query_all(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT name FROM pragma_table_info('personal_agent_item') \
                 WHERE name IN ('closed_at','closed_by','closed_how','answer_row_id','answer_state')"
                    .to_owned(),
            ))
            .await
            .expect("columns");
        assert_eq!(cols.len(), 5);
    }
}
