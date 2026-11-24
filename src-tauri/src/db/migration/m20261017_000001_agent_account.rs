use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::{ConnectionTrait, DbBackend, Statement};

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let conn = manager.get_connection();
        for sql in [
            "CREATE TABLE agent_account (id TEXT PRIMARY KEY NOT NULL, agent_type TEXT NOT NULL, name TEXT NOT NULL, home_dir TEXT NOT NULL, removed BOOLEAN NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
            "CREATE UNIQUE INDEX agent_account_name ON agent_account(agent_type, name COLLATE NOCASE) WHERE removed = 0",
            "CREATE UNIQUE INDEX agent_account_home ON agent_account(agent_type, home_dir) WHERE removed = 0",
            // Keep the binding when an account is removed. SET NULL would
            // silently start its conversations using the default subscription.
            "ALTER TABLE conversation ADD COLUMN agent_account_id TEXT REFERENCES agent_account(id)",
            "CREATE INDEX conversation_agent_account ON conversation(agent_account_id)",
            "DROP INDEX idx_conversation_external_agent",
            "CREATE UNIQUE INDEX idx_conversation_external_agent ON conversation(external_id, agent_type, IFNULL(agent_account_id, ''))",
        ] {
            conn.execute(Statement::from_string(DbBackend::Sqlite, sql.to_owned())).await?;
        }
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let conn = manager.get_connection();
        let bound = conn
            .query_one(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT COUNT(*) AS count FROM conversation WHERE agent_account_id IS NOT NULL"
                    .to_owned(),
            ))
            .await?;
        if bound.is_some_and(|row| row.try_get::<i64>("", "count").unwrap_or(1) != 0) {
            return Err(DbErr::Custom(
                "Cannot remove account bindings while conversations still use them".into(),
            ));
        }
        for sql in [
            "DROP INDEX idx_conversation_external_agent",
            "DROP INDEX conversation_agent_account",
            "ALTER TABLE conversation DROP COLUMN agent_account_id",
            "DROP TABLE agent_account",
            "CREATE UNIQUE INDEX idx_conversation_external_agent ON conversation(external_id, agent_type)",
        ] {
            conn.execute(Statement::from_string(DbBackend::Sqlite, sql.to_owned())).await?;
        }
        Ok(())
    }
}
