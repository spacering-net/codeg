use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // Where a conversation was started from, when that was not the window:
        // `cli` for a `codeg-cli` run, which the sidebar marks and can filter
        // on. NULL on every other row — every row from before, too. Text, not
        // an enum: a value a newer build writes must not make an older one
        // fail to decode the whole row. No index: the sidebar filters the
        // list it already loaded.
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .add_column(ColumnDef::new(Conversation::Source).text().null())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .drop_column(Conversation::Source)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum Conversation {
    Table,
    Source,
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

    /// A conversation from before reads back through the entity with no
    /// source: it was started from the window.
    #[tokio::test]
    async fn existing_rows_read_back_without_a_source() {
        let conn = Database::connect("sqlite::memory:").await.expect("db");
        let migrations = <Migrator as MigratorTrait>::migrations();
        let idx = migrations
            .iter()
            .position(|m| m.name().contains("conversation_source"))
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
            .expect("the source migration");

        let row = conversation::Entity::find_by_id(7)
            .one(&conn)
            .await
            .expect("row decodes")
            .expect("row exists");
        assert_eq!(row.source, None);
    }

    /// Backups only know a database by its newest migration: this one has to
    /// be the last, after every one already released.
    #[test]
    fn it_comes_after_every_released_migration() {
        let migrations = <Migrator as MigratorTrait>::migrations();
        let names: Vec<String> = migrations.iter().map(|m| m.name().to_string()).collect();
        let this = names
            .iter()
            .position(|n| n.contains("conversation_source"))
            .expect("registered");
        let released_last = names
            .iter()
            .position(|n| n.contains("m20261016_000002_conversation_assistant"))
            .expect("v0.36.0's last migration");
        assert!(this > released_last, "{names:?}");
    }
}
