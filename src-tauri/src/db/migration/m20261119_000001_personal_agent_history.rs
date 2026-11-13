use sea_orm_migration::prelude::*;

/// The time machine (8.2): what is searched — each assistant's timeline, the
/// messages between them, every conversation's inputs and last answers, the
/// board's tasks — one document each, a full-text index over them (FTS5,
/// trigrams, so Chinese and Japanese are found by any three characters), and
/// how far each source has been read.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(PersonalAgentHistoryDoc::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(PersonalAgentHistoryDoc::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    // `timeline`, `message`, `session` or `task`.
                    .col(
                        ColumnDef::new(PersonalAgentHistoryDoc::Source)
                            .text()
                            .not_null(),
                    )
                    // The row, message, conversation or task.
                    .col(
                        ColumnDef::new(PersonalAgentHistoryDoc::RefId)
                            .integer()
                            .not_null(),
                    )
                    // Within a conversation, its turn (`turn-3`) or `title`;
                    // empty otherwise.
                    .col(
                        ColumnDef::new(PersonalAgentHistoryDoc::Part)
                            .text()
                            .not_null(),
                    )
                    // `owner`, `assistant`, `agent`, `codeg`, `message`,
                    // `task` or `title`.
                    .col(
                        ColumnDef::new(PersonalAgentHistoryDoc::Role)
                            .text()
                            .not_null(),
                    )
                    // Whose: the timeline's assistant, the message's sender,
                    // the assistant that handed the work out.
                    .col(
                        ColumnDef::new(PersonalAgentHistoryDoc::BotId)
                            .integer()
                            .null(),
                    )
                    // A message's receiver.
                    .col(
                        ColumnDef::new(PersonalAgentHistoryDoc::PeerBotId)
                            .integer()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentHistoryDoc::FolderId)
                            .integer()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentHistoryDoc::AgentType)
                            .text()
                            .null(),
                    )
                    .col(ColumnDef::new(PersonalAgentHistoryDoc::Title).text().null())
                    .col(
                        ColumnDef::new(PersonalAgentHistoryDoc::Body)
                            .text()
                            .not_null(),
                    )
                    // 3 the assistants' own, 2 the rest, 1 what automations,
                    // the board and dispatches made.
                    .col(
                        ColumnDef::new(PersonalAgentHistoryDoc::Weight)
                            .integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentHistoryDoc::At)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    // Where a hit opens: the timeline row, the conversation.
                    .col(
                        ColumnDef::new(PersonalAgentHistoryDoc::RowId)
                            .integer()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentHistoryDoc::ConversationId)
                            .integer()
                            .null(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_personal_agent_history_doc_ref")
                    .table(PersonalAgentHistoryDoc::Table)
                    .col(PersonalAgentHistoryDoc::Source)
                    .col(PersonalAgentHistoryDoc::RefId)
                    .col(PersonalAgentHistoryDoc::Part)
                    .unique()
                    .if_not_exists()
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_personal_agent_history_doc_at")
                    .table(PersonalAgentHistoryDoc::Table)
                    .col(PersonalAgentHistoryDoc::At)
                    .if_not_exists()
                    .to_owned(),
            )
            .await?;
        manager
            .create_table(
                Table::create()
                    .table(PersonalAgentHistoryCursor::Table)
                    .if_not_exists()
                    // `timeline`, `message`, `task` (ref 0: how far read), or
                    // `session` (ref: the conversation, as last read).
                    .col(
                        ColumnDef::new(PersonalAgentHistoryCursor::Source)
                            .text()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentHistoryCursor::RefId)
                            .integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentHistoryCursor::At)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentHistoryCursor::Mark)
                            .integer()
                            .null(),
                    )
                    .primary_key(
                        Index::create()
                            .col(PersonalAgentHistoryCursor::Source)
                            .col(PersonalAgentHistoryCursor::RefId),
                    )
                    .to_owned(),
            )
            .await?;
        // The index reads its text from the documents (external content)
        // and is kept in step with them by the triggers.
        let conn = manager.get_connection();
        for sql in [
            "CREATE VIRTUAL TABLE IF NOT EXISTS personal_agent_history_fts USING fts5(\
                body, content='personal_agent_history_doc', content_rowid='id', \
                tokenize='trigram')",
            "CREATE TRIGGER IF NOT EXISTS personal_agent_history_doc_ai \
                AFTER INSERT ON personal_agent_history_doc BEGIN \
                INSERT INTO personal_agent_history_fts(rowid, body) VALUES (new.id, new.body); \
                END",
            "CREATE TRIGGER IF NOT EXISTS personal_agent_history_doc_ad \
                AFTER DELETE ON personal_agent_history_doc BEGIN \
                INSERT INTO personal_agent_history_fts(personal_agent_history_fts, rowid, body) \
                VALUES ('delete', old.id, old.body); \
                END",
            "CREATE TRIGGER IF NOT EXISTS personal_agent_history_doc_au \
                AFTER UPDATE OF body ON personal_agent_history_doc BEGIN \
                INSERT INTO personal_agent_history_fts(personal_agent_history_fts, rowid, body) \
                VALUES ('delete', old.id, old.body); \
                INSERT INTO personal_agent_history_fts(rowid, body) VALUES (new.id, new.body); \
                END",
        ] {
            conn.execute_unprepared(sql).await?;
        }
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let conn = manager.get_connection();
        for sql in [
            "DROP TRIGGER IF EXISTS personal_agent_history_doc_au",
            "DROP TRIGGER IF EXISTS personal_agent_history_doc_ad",
            "DROP TRIGGER IF EXISTS personal_agent_history_doc_ai",
            "DROP TABLE IF EXISTS personal_agent_history_fts",
        ] {
            conn.execute_unprepared(sql).await?;
        }
        manager
            .drop_table(
                Table::drop()
                    .table(PersonalAgentHistoryCursor::Table)
                    .if_exists()
                    .to_owned(),
            )
            .await?;
        manager
            .drop_table(
                Table::drop()
                    .table(PersonalAgentHistoryDoc::Table)
                    .if_exists()
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum PersonalAgentHistoryDoc {
    Table,
    Id,
    Source,
    RefId,
    Part,
    Role,
    BotId,
    PeerBotId,
    FolderId,
    AgentType,
    Title,
    Body,
    Weight,
    At,
    RowId,
    ConversationId,
}

#[derive(DeriveIden)]
enum PersonalAgentHistoryCursor {
    Table,
    Source,
    RefId,
    At,
    Mark,
}
