use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // One column per statement: SQLite rejects a multi-action ALTER TABLE.
        //
        // Per-agent memory of the last shared-catalog provider and model
        // applied to one of its conversations. Launch paths that have no
        // conversation selection of their own — the pre-bind session, or a
        // conversation created before the user picked anything — resolve
        // credentials from here, so an agent that needs them to start
        // (`qwen-code` refuses `session/new` without an API key) is not stuck
        // waiting for a conversation that cannot start without them.
        manager
            .alter_table(
                Table::alter()
                    .table(AgentSetting::Table)
                    .add_column(
                        ColumnDef::new(AgentSetting::CatalogProviderId)
                            .text()
                            .null(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(AgentSetting::Table)
                    .add_column(ColumnDef::new(AgentSetting::CatalogModelId).text().null())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(AgentSetting::Table)
                    .drop_column(AgentSetting::CatalogProviderId)
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(AgentSetting::Table)
                    .drop_column(AgentSetting::CatalogModelId)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum AgentSetting {
    Table,
    CatalogProviderId,
    CatalogModelId,
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm_migration::sea_orm::{ConnectionTrait, Database, DbBackend, Statement};

    /// Existing rows have no memory, and the migration must leave it that way —
    /// defaulting to some provider would silently point agents at a catalog
    /// entry the user never chose for them.
    #[tokio::test]
    async fn up_leaves_existing_rows_without_a_remembered_selection() {
        let conn = Database::connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        conn.execute_unprepared(
            "CREATE TABLE agent_setting (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_type TEXT)",
        )
        .await
        .expect("create stub table");
        conn.execute_unprepared("INSERT INTO agent_setting (agent_type) VALUES ('\"cline\"')")
            .await
            .expect("insert row");

        Migration
            .up(&SchemaManager::new(&conn))
            .await
            .expect("run migration up");

        let rows = conn
            .query_all(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT catalog_provider_id, catalog_model_id FROM agent_setting".to_owned(),
            ))
            .await
            .expect("query rows");
        assert_eq!(rows.len(), 1);
        let provider: Option<String> = rows[0]
            .try_get("", "catalog_provider_id")
            .expect("catalog_provider_id col");
        let model: Option<String> = rows[0]
            .try_get("", "catalog_model_id")
            .expect("catalog_model_id col");
        assert!(provider.is_none() && model.is_none());
    }
}
