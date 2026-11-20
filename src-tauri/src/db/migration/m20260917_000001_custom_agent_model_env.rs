use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(CustomAgent::Table)
                    // Optional JSON declaration (`CustomAgentDef::model_env`) of
                    // the env-var names this agent reads for the shared Model
                    // Provider projection. Nullable: absent means "use the
                    // standard convention keys for the provider's API family",
                    // which is what every row stored before this column did.
                    .add_column(ColumnDef::new(CustomAgent::ModelEnv).text().null())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(CustomAgent::Table)
                    .drop_column(CustomAgent::ModelEnv)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum CustomAgent {
    Table,
    ModelEnv,
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm_migration::sea_orm::{ConnectionTrait, Database, DbBackend, Statement};

    /// Rows registered before this column existed have no declaration, so the
    /// migration must leave the column NULL — a JSON default would make codeg
    /// inject provider credentials under names those agents never read.
    #[tokio::test]
    async fn up_leaves_existing_rows_without_a_declaration() {
        let conn = Database::connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        conn.execute_unprepared(
            "CREATE TABLE custom_agent (id INTEGER PRIMARY KEY AUTOINCREMENT, registry_id TEXT)",
        )
        .await
        .expect("create stub table");
        conn.execute_unprepared("INSERT INTO custom_agent (registry_id) VALUES ('qwen-code')")
            .await
            .expect("insert row");

        Migration
            .up(&SchemaManager::new(&conn))
            .await
            .expect("run migration up");

        let rows = conn
            .query_all(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT model_env FROM custom_agent".to_owned(),
            ))
            .await
            .expect("query rows");
        assert_eq!(rows.len(), 1);
        let model_env: Option<String> = rows[0].try_get("", "model_env").expect("model_env col");
        assert!(
            model_env.is_none(),
            "pre-existing rows must stay undeclared"
        );
    }
}
