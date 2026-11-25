use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "CREATE TABLE conversation_turn (
            turn_id TEXT PRIMARY KEY NOT NULL,
            conversation_id INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
            state TEXT NOT NULL,
            result_text TEXT,
            stop_reason TEXT,
            cause_message_id TEXT,
            root_id TEXT NOT NULL,
            source_conversation_id INTEGER NOT NULL,
            hop INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            completed_at TEXT
        )",
        )
        .await?;
        db.execute_unprepared("CREATE INDEX idx_conversation_turn_active ON conversation_turn(conversation_id, state)").await?;
        db.execute_unprepared("CREATE TABLE delegation_delivery (
            child_conversation_id INTEGER PRIMARY KEY NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
            parent_conversation_id INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
            first_turn_id TEXT NOT NULL REFERENCES conversation_turn(turn_id) ON DELETE CASCADE,
            notify_mode TEXT NOT NULL DEFAULT 'poll',
            follow BOOLEAN NOT NULL DEFAULT 0
        )").await?;
        for sql in [
            "ALTER TABLE session_message ADD COLUMN recipient_turn_id TEXT",
            "ALTER TABLE session_message ADD COLUMN result_turn_id TEXT",
            "ALTER TABLE session_message ADD COLUMN cause_message_id TEXT",
            "ALTER TABLE session_message ADD COLUMN root_id TEXT",
            "ALTER TABLE session_message ADD COLUMN source_conversation_id INTEGER",
            "ALTER TABLE session_message ADD COLUMN hop INTEGER NOT NULL DEFAULT 0",
            "CREATE UNIQUE INDEX idx_session_message_result_recipient ON session_message(result_turn_id, conversation_id) WHERE result_turn_id IS NOT NULL",
            "CREATE INDEX idx_session_message_recipient_turn ON session_message(recipient_turn_id)",
        ] { db.execute_unprepared(sql).await?; }
        Ok(())
    }
    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("DROP TABLE delegation_delivery")
            .await?;
        db.execute_unprepared("DROP TABLE conversation_turn")
            .await?;
        db.execute_unprepared("DROP INDEX idx_session_message_result_recipient")
            .await?;
        db.execute_unprepared("DROP INDEX idx_session_message_recipient_turn")
            .await?;
        for column in [
            "recipient_turn_id",
            "result_turn_id",
            "cause_message_id",
            "root_id",
            "source_conversation_id",
            "hop",
        ] {
            db.execute_unprepared(&format!("ALTER TABLE session_message DROP COLUMN {column}"))
                .await?;
        }
        Ok(())
    }
}
