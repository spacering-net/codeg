use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::{ConnectionTrait, DbBackend, Statement};

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // work_task_source_key: which forge work items a task handles. Until
        // now that was the one `work_task.source_key` column, which cannot say
        // "this task handles issues #3, #5 and #9" — a task the repository
        // panel makes from several related issues. A table rather than a list
        // inside `source_meta`: the keys are QUERIED (dedup, the resurrection
        // guards, the panel's reverse lookup, auto-processing), and the JSON
        // snapshot has a standing "replayed, never queried" contract. And one
        // table rather than this plus the old column: two places answering
        // "which tasks handle item X" is two answers waiting to disagree, so
        // from here on the column is display-only (the lead item) and every
        // such question reads this.
        manager
            .create_table(
                Table::create()
                    .table(WorkTaskSourceKey::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(WorkTaskSourceKey::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(WorkTaskSourceKey::TaskId).integer().not_null())
                    // Always `forge::source_key` output — never hand-built.
                    .col(ColumnDef::new(WorkTaskSourceKey::SourceKey).text().not_null())
                    // The item's place in the task, from 0 (the lead item).
                    .col(
                        ColumnDef::new(WorkTaskSourceKey::Position)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    // Tasks are only ever soft-deleted, and a deleted task
                    // keeps its rows (auto-processing counts it as handled);
                    // the cascade is for completeness, like `work_task_event`.
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_work_task_source_key_task_id")
                            .from(WorkTaskSourceKey::Table, WorkTaskSourceKey::TaskId)
                            .to(WorkTask::Table, WorkTask::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        // A task carries an item at most once. Deliberately NOT unique on the
        // key alone: "one active task per work item" is an advisory rule with
        // an explicit user override, and finished tasks for the same item are
        // legitimate history.
        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_work_task_source_key_task_key")
                    .table(WorkTaskSourceKey::Table)
                    .col(WorkTaskSourceKey::TaskId)
                    .col(WorkTaskSourceKey::SourceKey)
                    .unique()
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_work_task_source_key_key")
                    .table(WorkTaskSourceKey::Table)
                    .col(WorkTaskSourceKey::SourceKey)
                    .to_owned(),
            )
            .await?;

        // Every task triggered so far handles exactly the one item its column
        // names. Soft-deleted rows included: auto-processing's "has this item
        // ever had a task" counts them, and has to keep counting them.
        manager
            .get_connection()
            .execute(Statement::from_string(
                DbBackend::Sqlite,
                "INSERT INTO work_task_source_key (task_id, source_key, position) \
                 SELECT id, source_key, 0 FROM work_task WHERE source_key IS NOT NULL"
                    .to_string(),
            ))
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(WorkTaskSourceKey::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum WorkTaskSourceKey {
    Table,
    Id,
    TaskId,
    SourceKey,
    Position,
}

#[derive(DeriveIden)]
enum WorkTask {
    Table,
    Id,
}

#[cfg(test)]
mod tests {
    use sea_orm::{ConnectionTrait, Database, DbBackend, EntityTrait, QueryOrder, Statement};
    use sea_orm_migration::{MigrationName, MigratorTrait};

    use crate::db::entities::work_task_source_key;
    use crate::db::migration::Migrator;

    /// Every task triggered before the table existed gets the one item row
    /// its column names — soft-deleted ones too, which auto-processing still
    /// counts as handled — and a task without provenance gets none.
    #[tokio::test]
    async fn every_existing_forge_task_gets_its_one_item_row() {
        let conn = Database::connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        let all = Migrator::migrations();
        let at = all
            .iter()
            .position(|m| m.name() == super::Migration.name())
            .expect("listed");
        Migrator::up(&conn, Some(at as u32)).await.expect("migrations before");

        // Raw SQL, naming only columns that exist at this point in history.
        for (title, key, deleted) in [
            ("#7 · live", Some("github:github.com:acme/app:issue:7"), false),
            ("#8 · deleted", Some("github:github.com:acme/app:issue:8"), true),
            ("plain", None, false),
        ] {
            let key = key.map_or("NULL".to_string(), |k| format!("'{k}'"));
            let kind = if key == "NULL" { "NULL" } else { "'forge_issue'" };
            let deleted = if deleted { "'2026-11-01T00:00:00Z'" } else { "NULL" };
            conn.execute(Statement::from_string(
                DbBackend::Sqlite,
                format!(
                    "INSERT INTO work_task (folder_id, title, config, source_kind, source_key, \
                     created_at, updated_at, deleted_at) VALUES (1, '{title}', '{{}}', {kind}, \
                     {key}, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', {deleted})"
                ),
            ))
            .await
            .expect("old row");
        }

        Migrator::up(&conn, Some(1)).await.expect("this migration");
        let rows = work_task_source_key::Entity::find()
            .order_by_asc(work_task_source_key::Column::TaskId)
            .all(&conn)
            .await
            .expect("item rows");
        let got: Vec<(i32, &str, i32)> = rows
            .iter()
            .map(|r| (r.task_id, r.source_key.as_str(), r.position))
            .collect();
        assert_eq!(
            got,
            vec![
                (1, "github:github.com:acme/app:issue:7", 0),
                (2, "github:github.com:acme/app:issue:8", 0),
            ]
        );
    }
}
