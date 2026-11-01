use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for column in [
            "from_account_id",
            "to_account_id",
            "history_json",
            "context_id",
        ] {
            manager
                .alter_table(
                    Table::alter()
                        .table(Alias::new("conversation_handoff"))
                        .add_column(ColumnDef::new(Alias::new(column)).text())
                        .to_owned(),
                )
                .await?;
        }
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("conversation_handoff"))
                    .add_column(
                        ColumnDef::new(Alias::new("context_pending"))
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .to_owned(),
            )
            .await
    }
    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for column in [
            "from_account_id",
            "to_account_id",
            "history_json",
            "context_id",
            "context_pending",
        ] {
            manager
                .alter_table(
                    Table::alter()
                        .table(Alias::new("conversation_handoff"))
                        .drop_column(Alias::new(column))
                        .to_owned(),
                )
                .await?;
        }
        Ok(())
    }
}
