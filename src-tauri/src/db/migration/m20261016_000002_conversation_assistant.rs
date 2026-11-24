use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // A delegation child that ran as an assistant remembers which one, and
        // what that assistant was at the moment of delegation. Written once
        // when the child row is created, never updated, and NULL on every
        // other row — including every child created before assistants existed.
        //
        // No foreign key: assistants are only soft-deleted, and the child must
        // keep its identity even when the assistant row is missing altogether
        // (another device's database restored without it, say). No index: both
        // are only ever read off a row already found by its own id.
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .add_column(ColumnDef::new(Conversation::AssistantId).integer().null())
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    // JSON `{"name", "agent_options", "instructions"}`. Resuming
                    // the child replays THIS, not the assistant's current row:
                    // the assistant may since have moved to another agent, and
                    // the resumed session is still the original agent's.
                    .add_column(
                        ColumnDef::new(Conversation::AssistantSnapshot)
                            .text()
                            .null(),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .drop_column(Conversation::AssistantSnapshot)
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .drop_column(Conversation::AssistantId)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum Conversation {
    Table,
    AssistantId,
    AssistantSnapshot,
}

#[cfg(test)]
mod tests {
    use sea_orm::{ConnectionTrait, Database, DbBackend, EntityTrait, Statement};
    use sea_orm_migration::MigratorTrait;

    use crate::db::entities::conversation;
    use crate::db::migration::Migrator;

    fn sql(s: &str) -> Statement {
        Statement::from_string(DbBackend::Sqlite, s.to_owned())
    }

    /// A child delegated before assistants existed must read back through the
    /// entity with both new columns empty — the summary maps NULL to "not an
    /// assistant", which is exactly what that child was.
    #[tokio::test]
    async fn existing_rows_read_back_without_an_assistant() {
        let conn = Database::connect("sqlite::memory:").await.expect("db");
        let migrations = <Migrator as MigratorTrait>::migrations();
        let idx = migrations
            .iter()
            .position(|m| m.name().contains("conversation_assistant"))
            .expect("migration is registered");
        Migrator::up(&conn, Some(idx as u32))
            .await
            .expect("legacy migrations");
        conn.execute(sql(
            "INSERT INTO folder (id, name, path, last_opened_at, created_at, updated_at) VALUES \
             (1, 'repo', '/tmp/repo', '2026-10-01 00:00:00', '2026-10-01 00:00:00', \
              '2026-10-01 00:00:00')",
        ))
        .await
        .expect("legacy folder");
        conn.execute(sql(
            "INSERT INTO conversation (id, folder_id, title_locked, agent_type, status, kind, \
             parent_id, message_count, created_at, updated_at) VALUES \
             (7, 1, 0, 'codex', 'completed', 'delegate', 3, 1, \
              '2026-10-01 00:00:00', '2026-10-01 00:00:00')",
        ))
        .await
        .expect("legacy child");

        Migrator::up(&conn, None)
            .await
            .expect("assistant migrations");

        let row = conversation::Entity::find_by_id(7)
            .one(&conn)
            .await
            .expect("row decodes")
            .expect("row exists");
        assert_eq!(row.assistant_id, None);
        assert_eq!(row.assistant_snapshot, None);
    }
}
