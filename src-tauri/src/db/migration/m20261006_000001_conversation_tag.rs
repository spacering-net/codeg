use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::{ConnectionTrait, DbBackend, Statement};

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // conversation_tag: a user-defined label (text + colour) that can be put
        // on conversations. `folder_id` is the tag's SCOPE: NULL = a global tag,
        // offered on every conversation; otherwise the ROOT folder it belongs
        // to, offered only on that folder's conversations (worktree children
        // included — they resolve to their root). Hidden chat folders never own
        // tags, so a chat-mode conversation is offered the global ones only.
        //
        // HARD-deleted, like `folder_group`: the only things referencing a tag
        // are its links, which go with it. The folder FK cascades too, although
        // folders are only ever soft-deleted today — a soft-deleted folder keeps
        // its tags, so reopening the same path brings them back.
        manager
            .create_table(
                Table::create()
                    .table(ConversationTag::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(ConversationTag::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(ConversationTag::FolderId).integer().null())
                    .col(ColumnDef::new(ConversationTag::Name).text().not_null())
                    // Always a normalized `#rrggbb`. One colour serves both
                    // themes: the frontend derives the light and dark
                    // treatments from it.
                    .col(ColumnDef::new(ConversationTag::Color).text().not_null())
                    // Position among the tags of the SAME scope.
                    .col(
                        ColumnDef::new(ConversationTag::SortOrder)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(ConversationTag::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ConversationTag::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_conversation_tag_folder_id")
                            .from(ConversationTag::Table, ConversationTag::FolderId)
                            .to(Folder::Table, Folder::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_conversation_tag_folder_id")
                    .table(ConversationTag::Table)
                    .col(ConversationTag::FolderId)
                    .to_owned(),
            )
            .await?;

        // One name per scope, case-insensitively. An expression index because a
        // plain UNIQUE(folder_id, name) never fires for global tags: SQLite
        // treats every NULL as distinct. Folder ids start at 1, so the 0 that
        // stands in for "global" cannot collide with a real folder. NOCASE only
        // folds ASCII; the service layer's check folds the rest, and this index
        // is the backstop for two writers racing past that check.
        let conn = manager.get_connection();
        conn.execute(Statement::from_string(
            DbBackend::Sqlite,
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_tag_scope_name \
             ON conversation_tag (IFNULL(folder_id, 0), name COLLATE NOCASE)"
                .to_string(),
        ))
        .await?;

        // conversation_tag_link: which tags a conversation carries. Both FKs
        // cascade, so deleting a tag takes its links with it. Conversations are
        // only ever soft-deleted, so theirs stay behind — harmless, since every
        // reader starts from live conversation rows.
        manager
            .create_table(
                Table::create()
                    .table(ConversationTagLink::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(ConversationTagLink::ConversationId)
                            .integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ConversationTagLink::TagId)
                            .integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ConversationTagLink::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .primary_key(
                        Index::create()
                            .col(ConversationTagLink::ConversationId)
                            .col(ConversationTagLink::TagId),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_conversation_tag_link_conversation_id")
                            .from(
                                ConversationTagLink::Table,
                                ConversationTagLink::ConversationId,
                            )
                            .to(Conversation::Table, Conversation::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_conversation_tag_link_tag_id")
                            .from(ConversationTagLink::Table, ConversationTagLink::TagId)
                            .to(ConversationTag::Table, ConversationTag::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        // The primary key already serves "tags of a conversation"; this one
        // serves the reverse — a tag's links, read when it is deleted.
        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_conversation_tag_link_tag_id")
                    .table(ConversationTagLink::Table)
                    .col(ConversationTagLink::TagId)
                    .to_owned(),
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(ConversationTagLink::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(ConversationTag::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum ConversationTag {
    Table,
    Id,
    FolderId,
    Name,
    Color,
    SortOrder,
    CreatedAt,
    UpdatedAt,
}

#[derive(DeriveIden)]
enum ConversationTagLink {
    Table,
    ConversationId,
    TagId,
    CreatedAt,
}

#[derive(DeriveIden)]
enum Folder {
    Table,
    Id,
}

#[derive(DeriveIden)]
enum Conversation {
    Table,
    Id,
}
