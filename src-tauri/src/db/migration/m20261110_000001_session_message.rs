use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::{ConnectionTrait, DbBackend, Statement};

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(SessionMessage::Table)
                    .col(
                        ColumnDef::new(SessionMessage::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(SessionMessage::MessageId)
                            .string()
                            .not_null()
                            .unique_key(),
                    )
                    .col(
                        ColumnDef::new(SessionMessage::SenderConversationId)
                            .integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SessionMessage::ConversationId)
                            .integer()
                            .not_null(),
                    )
                    .col(ColumnDef::new(SessionMessage::Message).text().not_null())
                    .col(ColumnDef::new(SessionMessage::Delivery).string().not_null())
                    .col(ColumnDef::new(SessionMessage::Status).string().not_null())
                    .col(ColumnDef::new(SessionMessage::OwnerPid).big_integer())
                    .col(ColumnDef::new(SessionMessage::Result).text())
                    .col(ColumnDef::new(SessionMessage::Error).text())
                    .col(
                        ColumnDef::new(SessionMessage::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SessionMessage::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(SessionMessage::Table, SessionMessage::SenderConversationId)
                            .to(Conversation::Table, Conversation::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(SessionMessage::Table, SessionMessage::ConversationId)
                            .to(Conversation::Table, Conversation::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_session_message_queue")
                    .table(SessionMessage::Table)
                    .col(SessionMessage::ConversationId)
                    .col(SessionMessage::Status)
                    .col(SessionMessage::Delivery)
                    .col(SessionMessage::Id)
                    .to_owned(),
            )
            .await?;
        manager.get_connection().execute(Statement::from_string(DbBackend::Sqlite,
            "CREATE UNIQUE INDEX idx_session_message_running ON session_message(conversation_id) WHERE status = 'running'".to_owned())).await?;
        manager.get_connection().execute(Statement::from_string(DbBackend::Sqlite,
            "CREATE UNIQUE INDEX idx_session_message_dispatching ON session_message(conversation_id) WHERE status = 'dispatching'".to_owned())).await?;
        Ok(())
    }
    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(SessionMessage::Table).to_owned())
            .await
    }
}
#[derive(DeriveIden)]
enum SessionMessage {
    Table,
    Id,
    MessageId,
    SenderConversationId,
    ConversationId,
    Message,
    Delivery,
    Status,
    OwnerPid,
    Result,
    Error,
    CreatedAt,
    UpdatedAt,
}
#[derive(DeriveIden)]
enum Conversation {
    Table,
    Id,
}
