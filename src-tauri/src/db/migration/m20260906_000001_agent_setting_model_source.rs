use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(AgentSetting::Table)
                    .add_column(
                        ColumnDef::new(AgentSetting::ModelSource)
                            .string()
                            .not_null()
                            .default("native"),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(AgentSetting::Table)
                    .drop_column(AgentSetting::ModelSource)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum AgentSetting {
    Table,
    ModelSource,
}
