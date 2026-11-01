use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // conversation_handoff: one row per time a conversation was handed to a
        // different agent in place (see `acp::handoff`). The conversation row
        // itself only ever names its CURRENT agent + session; this table is what
        // keeps the earlier segments reachable, so a conversation that moved
        // from Claude to Codex still renders the Claude turns above the divider.
        //
        // `conversation_id` is a SOFT reference (no FK): conversations
        // soft-delete, so a cascade would never fire, and a handoff record has
        // nothing to outlive: it is meaningless without its conversation and is
        // simply never read once the row is gone.
        manager
            .create_table(
                Table::create()
                    .table(ConversationHandoff::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(ConversationHandoff::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(ConversationHandoff::ConversationId)
                            .integer()
                            .not_null(),
                    )
                    // Position in the conversation's chain, oldest first.
                    .col(ColumnDef::new(ConversationHandoff::Seq).integer().not_null())
                    .col(
                        ColumnDef::new(ConversationHandoff::FromAgentType)
                            .text()
                            .not_null(),
                    )
                    // The session the earlier segment is read from. Its store
                    // belongs to `from_agent_type`, which is why the pair is
                    // kept rather than the id alone.
                    .col(ColumnDef::new(ConversationHandoff::FromExternalId).text())
                    .col(
                        ColumnDef::new(ConversationHandoff::ToAgentType)
                            .text()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ConversationHandoff::ToExternalId)
                            .text()
                            .not_null(),
                    )
                    // "native" | "summary"
                    .col(ColumnDef::new(ConversationHandoff::Path).text().not_null())
                    // True when the target session carries the whole prior
                    // history itself (native transfer), so the earlier segment
                    // must NOT be read again or it would render twice.
                    .col(
                        ColumnDef::new(ConversationHandoff::Carried)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    // User turns rendered at handoff time: where the divider
                    // goes inside a carried session.
                    .col(
                        ColumnDef::new(ConversationHandoff::UserTurnsBefore)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(ColumnDef::new(ConversationHandoff::Note).text())
                    // The briefing the target was seeded with (summary path).
                    .col(ColumnDef::new(ConversationHandoff::Briefing).text())
                    .col(
                        ColumnDef::new(ConversationHandoff::Truncated)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .col(
                        ColumnDef::new(ConversationHandoff::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await?;

        // Every detail read of a conversation asks "which handoffs does this
        // row have", so the lookup must not be a table scan.
        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_conversation_handoff_conversation_id")
                    .table(ConversationHandoff::Table)
                    .col(ConversationHandoff::ConversationId)
                    .to_owned(),
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(
                Table::drop()
                    .table(ConversationHandoff::Table)
                    .if_exists()
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum ConversationHandoff {
    Table,
    Id,
    ConversationId,
    Seq,
    FromAgentType,
    FromExternalId,
    ToAgentType,
    ToExternalId,
    Path,
    Carried,
    UserTurnsBefore,
    Note,
    Briefing,
    Truncated,
    CreatedAt,
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm_migration::sea_orm::{ConnectionTrait, Database, DbBackend, Statement};

    /// `up` creates the table with its defaults, so a row written with only the
    /// required columns reads back as an uncarried, untruncated handoff.
    #[tokio::test]
    async fn up_creates_the_table_with_defaults() {
        let conn = Database::connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");

        Migration
            .up(&SchemaManager::new(&conn))
            .await
            .expect("run migration up");

        conn.execute_unprepared(
            "INSERT INTO conversation_handoff (conversation_id, seq, from_agent_type, \
             to_agent_type, to_external_id, path, created_at) \
             VALUES (7, 0, 'claude_code', 'codex', 'S2', 'summary', '2026-09-06T00:00:00Z')",
        )
        .await
        .expect("insert row");

        let rows = conn
            .query_all(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT carried, truncated, user_turns_before, from_external_id \
                 FROM conversation_handoff"
                    .to_owned(),
            ))
            .await
            .expect("query rows");
        assert_eq!(rows.len(), 1);
        let carried: bool = rows[0].try_get("", "carried").expect("carried col");
        let truncated: bool = rows[0].try_get("", "truncated").expect("truncated col");
        let before: i32 = rows[0]
            .try_get("", "user_turns_before")
            .expect("user_turns_before col");
        let from: Option<String> = rows[0]
            .try_get("", "from_external_id")
            .expect("from_external_id col");
        assert!(!carried);
        assert!(!truncated);
        assert_eq!(before, 0);
        assert!(from.is_none());
    }

    /// `down` removes the table again, and `up` is idempotent over an existing
    /// table (`if_not_exists`), so a re-run cannot fail a fresh install.
    #[tokio::test]
    async fn up_is_idempotent_and_down_drops() {
        let conn = Database::connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        let manager = SchemaManager::new(&conn);
        Migration.up(&manager).await.expect("first up");
        Migration.up(&manager).await.expect("second up");
        Migration.down(&manager).await.expect("down");
        let rows = conn
            .query_all(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_handoff'"
                    .to_owned(),
            ))
            .await
            .expect("query sqlite_master");
        assert!(rows.is_empty(), "table must be gone after down");
    }
}
