use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // tool_approval: how each permission request a conversation's agent
        // raised was answered, keyed by the tool call it was about. Agent
        // transcripts record the call but not the approval, so without this a
        // reopened conversation loses every "approved" / "always allowed" mark
        // the live one showed.
        //
        // One row per (conversation, tool call): a later answer about the same
        // call replaces the earlier one. The conversation FK cascades, though
        // conversations are only ever soft-deleted today — a soft-deleted
        // conversation keeps its rows, which nothing reads.
        manager
            .create_table(
                Table::create()
                    .table(ToolApproval::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(ToolApproval::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(ToolApproval::ConversationId)
                            .integer()
                            .not_null(),
                    )
                    .col(ColumnDef::new(ToolApproval::ToolCallId).text().not_null())
                    // The chosen option's ACP kind (`allow_once`,
                    // `allow_always`, `reject_once`, `reject_always`), verbatim.
                    .col(ColumnDef::new(ToolApproval::OptionKind).text().not_null())
                    // The chosen option's label in the agent's own words.
                    .col(ColumnDef::new(ToolApproval::OptionName).text().not_null())
                    // Who answered: `user`, `chat_channel` or `cli_policy`.
                    .col(ColumnDef::new(ToolApproval::Origin).text().not_null())
                    .col(
                        ColumnDef::new(ToolApproval::DecidedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_tool_approval_conversation_id")
                            .from(ToolApproval::Table, ToolApproval::ConversationId)
                            .to(Conversation::Table, Conversation::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        // Serves both the upsert's conflict target and "a conversation's
        // approvals", read on every detail load.
        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_tool_approval_conversation_tool_call")
                    .table(ToolApproval::Table)
                    .col(ToolApproval::ConversationId)
                    .col(ToolApproval::ToolCallId)
                    .unique()
                    .to_owned(),
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(ToolApproval::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum ToolApproval {
    Table,
    Id,
    ConversationId,
    ToolCallId,
    OptionKind,
    OptionName,
    Origin,
    DecidedAt,
}

#[derive(DeriveIden)]
enum Conversation {
    Table,
    Id,
}
