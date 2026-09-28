use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(ConversationExternalAlias::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(ConversationExternalAlias::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(ConversationExternalAlias::ConversationId)
                            .integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ConversationExternalAlias::AgentType)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ConversationExternalAlias::Alias)
                            .string()
                            .not_null(),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_conversation_external_alias_conversation")
                            .from(
                                ConversationExternalAlias::Table,
                                ConversationExternalAlias::ConversationId,
                            )
                            .to(Conversation::Table, Conversation::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_conversation_external_alias_agent_alias")
                    .table(ConversationExternalAlias::Table)
                    .col(ConversationExternalAlias::AgentType)
                    .col(ConversationExternalAlias::Alias)
                    .unique()
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_conversation_external_alias_conversation")
                    .table(ConversationExternalAlias::Table)
                    .col(ConversationExternalAlias::ConversationId)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(ConversationExternalAlias::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum ConversationExternalAlias {
    Table,
    Id,
    ConversationId,
    AgentType,
    Alias,
}

#[derive(DeriveIden)]
enum Conversation {
    Table,
    Id,
}
