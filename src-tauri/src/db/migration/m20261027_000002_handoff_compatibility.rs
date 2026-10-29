use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

// Handoff backups must remain distinct from the refreshed native-account
// schema. Retain every earlier migration and marker for existing databases.
#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, _manager: &SchemaManager) -> Result<(), DbErr> { Ok(()) }
    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> { Ok(()) }
}
