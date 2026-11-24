use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;
#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(ConversationContext::Table)
                    .col(
                        ColumnDef::new(ConversationContext::ConversationId)
                            .integer()
                            .not_null()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(ConversationContext::Brief)
                            .text()
                            .not_null()
                            .default(""),
                    )
                    .col(
                        ColumnDef::new(ConversationContext::BriefUpdatedAt)
                            .timestamp_with_time_zone(),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(
                                ConversationContext::Table,
                                ConversationContext::ConversationId,
                            )
                            .to(Conversation::Table, Conversation::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await
    }
    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(ConversationContext::Table).to_owned())
            .await
    }
}
#[derive(DeriveIden)]
enum ConversationContext {
    Table,
    ConversationId,
    Brief,
    BriefUpdatedAt,
}
#[derive(DeriveIden)]
enum Conversation {
    Table,
    Id,
}
