use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(ConversationCheckpoint::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(ConversationCheckpoint::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(ConversationCheckpoint::ConversationId)
                            .integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ConversationCheckpoint::TurnId)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ConversationCheckpoint::TurnIndex)
                            .integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ConversationCheckpoint::UserPromptText)
                            .text()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ConversationCheckpoint::ShadowTreeHash)
                            .string()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(ConversationCheckpoint::PrevTurnId)
                            .string()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(ConversationCheckpoint::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_conversation_checkpoint_conv_turn")
                    .table(ConversationCheckpoint::Table)
                    .col(ConversationCheckpoint::ConversationId)
                    .col(ConversationCheckpoint::TurnIndex)
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(ConversationRollbackState::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(ConversationRollbackState::ConversationId)
                            .integer()
                            .not_null()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(ConversationRollbackState::PreservedTurnsJson)
                            .text()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(ConversationRollbackState::PendingContextNotice)
                            .text()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(ConversationRollbackState::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(
                Table::drop()
                    .table(ConversationRollbackState::Table)
                    .to_owned(),
            )
            .await?;
        manager
            .drop_table(
                Table::drop()
                    .table(ConversationCheckpoint::Table)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum ConversationCheckpoint {
    Table,
    Id,
    ConversationId,
    TurnId,
    TurnIndex,
    UserPromptText,
    ShadowTreeHash,
    PrevTurnId,
    CreatedAt,
}

#[derive(DeriveIden)]
enum ConversationRollbackState {
    Table,
    ConversationId,
    PreservedTurnsJson,
    PendingContextNotice,
    UpdatedAt,
}
