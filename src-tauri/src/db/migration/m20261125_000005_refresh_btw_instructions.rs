use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // Reuse the one-shot prompt flag to replace instructions in old /btw sessions.
        manager
            .get_connection()
            .execute_unprepared("UPDATE conversation SET btw_promoted = TRUE WHERE kind = 'btw'")
            .await?;
        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Ok(())
    }
}
