use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::{ConnectionTrait, DbBackend, Statement};

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // The per-agent "Adapter version" control kept its choice as a reserved
        // `CODEG_ADAPTER_CHANNEL` key in `env_json`. The control is gone, and a
        // leftover key would keep showing in the agent's env editor and keep
        // being exported into every launch of that agent, so strip it. A map
        // left empty is stored as NULL, the way `serialize_env_map` stores an
        // empty env. The CASE evaluates `json_valid` first, so a NULL or
        // malformed `env_json` is skipped instead of aborting the statement.
        let conn = manager.get_connection();
        let sql = "UPDATE agent_setting \
            SET env_json = CASE \
                WHEN json_remove(env_json, '$.CODEG_ADAPTER_CHANNEL') = '{}' THEN NULL \
                ELSE json_remove(env_json, '$.CODEG_ADAPTER_CHANNEL') END \
            WHERE CASE WHEN json_valid(env_json) \
                THEN json_type(env_json, '$.CODEG_ADAPTER_CHANNEL') IS NOT NULL \
                ELSE 0 END";
        conn.execute(Statement::from_string(DbBackend::Sqlite, sql.to_string()))
            .await?;
        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        // Nothing to restore: the key has no reader left.
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm_migration::sea_orm::Database;

    /// Only rows carrying the key change. Everything else, including env
    /// values the JSON functions cannot parse, must come through byte for
    /// byte, and none of it may abort the update for the other rows.
    #[tokio::test]
    async fn up_strips_only_the_adapter_channel_key() {
        let conn = Database::connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        conn.execute_unprepared(
            "CREATE TABLE agent_setting (id INTEGER PRIMARY KEY, env_json TEXT NULL)",
        )
        .await
        .expect("create stub table");

        let rows: [(i64, Option<&str>, Option<&str>); 8] = [
            // The key alone: the map ends up empty, stored as NULL.
            (1, Some(r#"{"CODEG_ADAPTER_CHANNEL":"latest"}"#), None),
            // The key next to real env: only the key goes.
            (
                2,
                Some(r#"{"XAI_API_KEY":"abc","CODEG_ADAPTER_CHANNEL":"latest"}"#),
                Some(r#"{"XAI_API_KEY":"abc"}"#),
            ),
            // An empty value still counts as the key being present.
            (3, Some(r#"{"CODEG_ADAPTER_CHANNEL":""}"#), None),
            // No key: untouched, formatting included.
            (
                4,
                Some(r#"{"XAI_API_KEY": "abc"}"#),
                Some(r#"{"XAI_API_KEY": "abc"}"#),
            ),
            (5, None, None),
            (6, Some("not json"), Some("not json")),
            (
                7,
                Some(r#"["CODEG_ADAPTER_CHANNEL"]"#),
                Some(r#"["CODEG_ADAPTER_CHANNEL"]"#),
            ),
            (8, Some(""), Some("")),
        ];
        for (id, env_json, _) in &rows {
            conn.execute(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                "INSERT INTO agent_setting (id, env_json) VALUES (?, ?)",
                [(*id).into(), env_json.map(str::to_owned).into()],
            ))
            .await
            .expect("insert row");
        }

        Migration
            .up(&SchemaManager::new(&conn))
            .await
            .expect("run migration up");

        for (id, _, expected) in &rows {
            let row = conn
                .query_one(Statement::from_sql_and_values(
                    DbBackend::Sqlite,
                    "SELECT env_json FROM agent_setting WHERE id = ?",
                    [(*id).into()],
                ))
                .await
                .expect("query row")
                .expect("row exists");
            let env_json: Option<String> = row.try_get("", "env_json").expect("env_json col");
            assert_eq!(env_json.as_deref(), *expected, "row {id}");
        }
    }
}
