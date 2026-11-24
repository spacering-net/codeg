use sea_orm_migration::prelude::*;
#[derive(DeriveMigrationName)]
pub struct Migration;
#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(ConversationContext::Table)
                    .add_column(ColumnDef::new(ConversationContext::Digest).text())
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(ConversationContext::Table)
                    .add_column(
                        ColumnDef::new(ConversationContext::DismissedSuggestions)
                            .text()
                            .not_null()
                            .default("[]"),
                    )
                    .to_owned(),
            )
            .await
    }
    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(ConversationContext::Table)
                    .drop_column(ConversationContext::DismissedSuggestions)
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(ConversationContext::Table)
                    .drop_column(ConversationContext::Digest)
                    .to_owned(),
            )
            .await
    }
}
#[derive(DeriveIden)]
enum ConversationContext {
    Table,
    Digest,
    DismissedSuggestions,
}
