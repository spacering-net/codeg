use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // `model_source` is nullable, not defaulted to "native": NULL means an
        // existing conversation still follows its legacy agent-owned runtime.
        // The provider columns are references by immutable string ids, not
        // database FKs, because models.json is the provider catalog source of
        // truth and may be shared with or replaced by a pios file.
        for column in [
            ColumnDef::new(Conversation::ModelSource).string().null(),
            ColumnDef::new(Conversation::ModelProviderId)
                .string()
                .null(),
            ColumnDef::new(Conversation::ModelProviderModelId)
                .string()
                .null(),
        ] {
            manager
                .alter_table(
                    Table::alter()
                        .table(Conversation::Table)
                        .add_column(column)
                        .to_owned(),
                )
                .await?;
        }
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for column in [
            Conversation::ModelProviderModelId,
            Conversation::ModelProviderId,
            Conversation::ModelSource,
        ] {
            manager
                .alter_table(
                    Table::alter()
                        .table(Conversation::Table)
                        .drop_column(column)
                        .to_owned(),
                )
                .await?;
        }
        Ok(())
    }
}

#[derive(DeriveIden)]
enum Conversation {
    Table,
    ModelSource,
    ModelProviderId,
    ModelProviderModelId,
}
