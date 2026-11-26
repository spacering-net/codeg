use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(
            "CREATE TABLE conversation_collaborator (
                source_id INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
                target_id INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
                PRIMARY KEY (source_id, target_id),
                CHECK (source_id <> target_id)
            )",
        ).await?;
        manager.get_connection().execute_unprepared(
            "CREATE INDEX idx_conversation_collaborator_target ON conversation_collaborator(target_id)",
        ).await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared("DROP TABLE conversation_collaborator").await?;
        Ok(())
    }
}
