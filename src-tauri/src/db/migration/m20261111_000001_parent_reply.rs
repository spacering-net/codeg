use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // Same SQLite ownership/FIFO model as subsession_message, addressed to
        // the parent rather than the child. Separate indexes serialize reports
        // from different children without blocking the existing child queue.
        manager.get_connection().execute_unprepared(
            "CREATE TABLE parent_reply (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id TEXT NOT NULL UNIQUE,
                parent_conversation_id INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
                child_conversation_id INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
                message TEXT NOT NULL,
                status TEXT NOT NULL,
                owner_pid BIGINT,
                result TEXT,
                error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX idx_parent_reply_queue ON parent_reply(parent_conversation_id, status, id);
            CREATE UNIQUE INDEX idx_parent_reply_running ON parent_reply(parent_conversation_id) WHERE status = 'running';"
        ).await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("DROP TABLE parent_reply")
            .await?;
        Ok(())
    }
}
