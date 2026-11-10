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
                    .table(SubsessionMessage::Table)
                    .col(
                        ColumnDef::new(SubsessionMessage::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(SubsessionMessage::MessageId)
                            .string()
                            .not_null()
                            .unique_key(),
                    )
                    .col(
                        ColumnDef::new(SubsessionMessage::ParentConversationId)
                            .integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SubsessionMessage::ChildConversationId)
                            .integer()
                            .not_null(),
                    )
                    .col(ColumnDef::new(SubsessionMessage::Message).text().not_null())
                    .col(
                        ColumnDef::new(SubsessionMessage::Delivery)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SubsessionMessage::Status)
                            .string()
                            .not_null(),
                    )
                    .col(ColumnDef::new(SubsessionMessage::OwnerPid).big_integer())
                    .col(ColumnDef::new(SubsessionMessage::Result).text())
                    .col(ColumnDef::new(SubsessionMessage::Error).text())
                    .col(
                        ColumnDef::new(SubsessionMessage::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SubsessionMessage::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(
                                SubsessionMessage::Table,
                                SubsessionMessage::ParentConversationId,
                            )
                            .to(Conversation::Table, Conversation::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(
                                SubsessionMessage::Table,
                                SubsessionMessage::ChildConversationId,
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
                    .name("idx_subsession_message_queue")
                    .table(SubsessionMessage::Table)
                    .col(SubsessionMessage::ChildConversationId)
                    .col(SubsessionMessage::Status)
                    .col(SubsessionMessage::Delivery)
                    .col(SubsessionMessage::Id)
                    .to_owned(),
            )
            .await?;
        manager.get_connection().execute(Statement::from_string(DbBackend::Sqlite,
            "CREATE UNIQUE INDEX idx_subsession_message_running ON subsession_message(child_conversation_id) WHERE status = 'running'".to_owned())).await?;
        manager.get_connection().execute(Statement::from_string(DbBackend::Sqlite,
            "CREATE UNIQUE INDEX idx_subsession_message_dispatching ON subsession_message(child_conversation_id) WHERE status = 'dispatching'".to_owned())).await?;
        Ok(())
    }
    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(SubsessionMessage::Table).to_owned())
            .await
    }
}
#[derive(DeriveIden)]
enum SubsessionMessage {
    Table,
    Id,
    MessageId,
    ParentConversationId,
    ChildConversationId,
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
