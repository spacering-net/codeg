use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // message_queue_item: the per-conversation "send later" queue, persisted
        // so it survives an app restart and — via the `message-queue://changed`
        // broadcast — stays in sync across every open window / web client.
        //
        // One row per queued message. `item_uid` is a client-generated UUID that
        // is stable across edits; `owner_id` is the conversation the queue belongs
        // to. The `draft` is JSON because `PromptDraft` is a frontend-only type.
        manager
            .create_table(
                Table::create()
                    .table(MessageQueueItem::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(MessageQueueItem::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(MessageQueueItem::OwnerId).string().not_null())
                    .col(ColumnDef::new(MessageQueueItem::ItemUid).string().not_null())
                    .col(ColumnDef::new(MessageQueueItem::DraftJson).text().not_null())
                    .col(ColumnDef::new(MessageQueueItem::ModeId).string().null())
                    .col(
                        ColumnDef::new(MessageQueueItem::AdoptSendTimeMode)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .col(
                        ColumnDef::new(MessageQueueItem::SortOrder)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(MessageQueueItem::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(MessageQueueItem::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await?;

        // "All items for a conversation", read on every queue load.
        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_message_queue_item_owner")
                    .table(MessageQueueItem::Table)
                    .col(MessageQueueItem::OwnerId)
                    .to_owned(),
            )
            .await?;

        // The upsert / delete conflict target.
        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_message_queue_item_owner_uid")
                    .table(MessageQueueItem::Table)
                    .col(MessageQueueItem::OwnerId)
                    .col(MessageQueueItem::ItemUid)
                    .unique()
                    .to_owned(),
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(MessageQueueItem::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum MessageQueueItem {
    Table,
    Id,
    OwnerId,
    ItemUid,
    DraftJson,
    ModeId,
    AdoptSendTimeMode,
    SortOrder,
    CreatedAt,
    UpdatedAt,
}
