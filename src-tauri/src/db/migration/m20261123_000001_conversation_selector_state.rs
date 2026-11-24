use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // The conversation's own selector state (applied mode, pending
        // composer mode, config option values) as JSON — written by the
        // backend from the live session, replayed when the conversation
        // reconnects. NULL for every row from before: such a conversation
        // takes a one-time fallback on its next connect and is frozen from
        // then on. Text, so a newer shape never stops an older build from
        // decoding the row.
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .add_column(ColumnDef::new(Conversation::SelectorState).text().null())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .drop_column(Conversation::SelectorState)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum Conversation {
    Table,
    SelectorState,
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

    /// A conversation from before reads back with no stored selection.
    #[tokio::test]
    async fn existing_rows_read_back_without_a_selection() {
        let conn = Database::connect("sqlite::memory:").await.expect("db");
        let migrations = <Migrator as MigratorTrait>::migrations();
        let idx = migrations
            .iter()
            .position(|m| m.name().contains("conversation_selector_state"))
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
             message_count, created_at, updated_at) VALUES \
             (7, 1, 0, 'codex', 'completed', 'regular', 1, \
              '2026-10-01 00:00:00', '2026-10-01 00:00:00')",
        ))
        .await
        .expect("legacy row");

        Migrator::up(&conn, None)
            .await
            .expect("the selector state migration");

        let row = conversation::Entity::find_by_id(7)
            .one(&conn)
            .await
            .expect("row decodes")
            .expect("row exists");
        assert_eq!(row.selector_state, None);
    }
}
