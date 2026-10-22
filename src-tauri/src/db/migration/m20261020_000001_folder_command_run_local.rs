use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // `run_local` marks a command the desktop app runs on its own machine,
        // detached, instead of in a terminal on the folder's host — the way a
        // remote window reaches local tools. Every existing command runs in a
        // terminal, so they all start out false.
        manager
            .alter_table(
                Table::alter()
                    .table(FolderCommand::Table)
                    .add_column(
                        ColumnDef::new(FolderCommand::RunLocal)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(FolderCommand::Table)
                    .drop_column(FolderCommand::RunLocal)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum FolderCommand {
    Table,
    RunLocal,
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm_migration::sea_orm::{ConnectionTrait, Database, DbBackend, Statement};

    #[tokio::test]
    async fn up_leaves_existing_commands_running_in_a_terminal() {
        let conn = Database::connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        conn.execute_unprepared(
            "CREATE TABLE folder_command (id INTEGER PRIMARY KEY AUTOINCREMENT, command TEXT NOT NULL)",
        )
        .await
        .expect("create stub table");
        conn.execute_unprepared("INSERT INTO folder_command (command) VALUES ('pnpm dev')")
            .await
            .expect("insert existing row");

        Migration
            .up(&SchemaManager::new(&conn))
            .await
            .expect("run migration up");

        let rows = conn
            .query_all(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT run_local FROM folder_command".to_owned(),
            ))
            .await
            .expect("query rows");
        assert_eq!(rows.len(), 1);
        let run_local: i32 = rows[0].try_get("", "run_local").expect("run_local");
        assert_eq!(run_local, 0);
    }
}
