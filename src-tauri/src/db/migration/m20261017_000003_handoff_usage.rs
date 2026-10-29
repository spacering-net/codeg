use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for column in ["source_stats_json", "source_model"] {
            manager.alter_table(Table::alter().table(Alias::new("conversation_handoff"))
                .add_column(ColumnDef::new(Alias::new(column)).text()).to_owned()).await?;
        }
        Ok(())
    }
    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for column in ["source_stats_json", "source_model"] {
            manager.alter_table(Table::alter().table(Alias::new("conversation_handoff"))
                .drop_column(Alias::new(column)).to_owned()).await?;
        }
        Ok(())
    }
}
