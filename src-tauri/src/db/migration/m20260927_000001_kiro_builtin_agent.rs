//! Retire a pre-integration `kiro-cli` CUSTOM agent into the built-in Kiro.
//!
//! Before Kiro CLI became a built-in, the only way to drive it was to register
//! it as a custom ACP agent — and the ACP registry's id for it, `kiro-cli`, is
//! exactly the registry id the built-in now claims. Custom-registry hydration
//! already refuses a definition that collides with a built-in id, so without
//! this migration such a user would see their custom agent vanish and every
//! conversation they had with it turn into an unregistered `custom:kiro-cli`
//! that can neither be reopened nor resumed.
//!
//! Both kinds of conversation point at the SAME session on disk: a custom
//! agent's `conversation.external_id` is the ACP session id, and `kiro-cli acp`
//! names its `~/.kiro/sessions/cli/<id>.jsonl` after that id — so re-typing the
//! rows is all it takes for `parsers::kiro` to read their history.
//!
//! Every place an agent type is persisted is rewritten:
//!
//! * plain wire strings — `conversation.agent_type`, `opened_tab.agent_type`,
//!   `folder.default_agent_type`, `automation.agent_type`,
//!   `chat_channel_sender_context.current_agent_type`, `canvas_node.agent_type`;
//! * `agent_setting.agent_type`, which stores the JSON-QUOTED form
//!   (`"custom:kiro-cli"`) — the enabled flag, order and launch env carry over;
//! * JSON configs that embed an agent type as a string value —
//!   `work_task.config`, `work_task_settings.config`,
//!   `work_task_template.config`, `automation.config`.
//!
//! The custom definition itself is then deleted. codeg's own ACP transcripts
//! of those sessions (`<data>/acp-transcripts/kiro-cli/`) are left on disk: the
//! built-in reads Kiro's native log instead, and deleting user data is not a
//! migration's call.
//!
//! Collisions (possible only on a database that already holds built-in `kiro`
//! rows, i.e. one a pre-release build wrote to) resolve toward the built-in
//! without losing anything: a `custom:kiro-cli` conversation whose session is
//! already imported as `kiro` hands its tabs to that row and is soft-deleted
//! (`deleted_at`), and an existing `kiro` settings row keeps its own state but
//! inherits the custom row's launch env and model provider where it has none.
//!
//! Irreversible by design — `down` is a no-op: once a user has new built-in
//! Kiro conversations, nothing can tell them apart from migrated ones.

use sea_orm::ConnectionTrait;
use sea_orm_migration::prelude::*;

const CUSTOM_WIRE: &str = "custom:kiro-cli";
const BUILTIN_WIRE: &str = "kiro";
const REGISTRY_ID: &str = "kiro-cli";

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        for statement in statements() {
            db.execute_unprepared(&statement).await?;
        }
        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Ok(())
    }
}

/// The whole migration as SQL, in order. Every value is a compile-time
/// constant, so nothing here is user input.
fn statements() -> Vec<String> {
    let custom = CUSTOM_WIRE;
    let builtin = BUILTIN_WIRE;
    let quoted_custom = format!("\"{CUSTOM_WIRE}\"");
    let quoted_builtin = format!("\"{BUILTIN_WIRE}\"");
    // A custom conversation whose session already exists as a `kiro` row —
    // re-typing it would trip the `(external_id, agent_type)` unique index.
    let duplicate = format!(
        "conversation.agent_type = '{custom}' AND conversation.external_id IS NOT NULL \
         AND EXISTS (SELECT 1 FROM conversation AS existing \
                     WHERE existing.agent_type = '{builtin}' \
                       AND existing.external_id = conversation.external_id)"
    );
    let mut out = vec![
        // Its tabs move to the built-in row that holds the same session…
        format!(
            "UPDATE opened_tab SET conversation_id = ( \
               SELECT existing.id FROM conversation AS existing \
               JOIN conversation AS dup ON dup.external_id = existing.external_id \
               WHERE existing.agent_type = '{builtin}' AND dup.id = opened_tab.conversation_id) \
             WHERE conversation_id IN (SELECT id FROM conversation WHERE {duplicate})"
        ),
        // …and the duplicate is hidden rather than deleted.
        format!(
            "UPDATE conversation SET deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP) \
             WHERE {duplicate}"
        ),
        // Every other custom conversation becomes a built-in one.
        format!(
            "UPDATE conversation SET agent_type = '{builtin}' \
             WHERE agent_type = '{custom}' \
               AND NOT EXISTS ( \
                 SELECT 1 FROM conversation AS existing \
                 WHERE existing.agent_type = '{builtin}' \
                   AND existing.external_id IS conversation.external_id \
                   AND conversation.external_id IS NOT NULL)"
        ),
        // Settings row (JSON-quoted key, unique): take over the custom row
        // unless the built-in already has one. The probed version is cleared —
        // the custom agent's `version_probe` output ("kiro-cli 2.24.1") is not
        // what the built-in's probe writes, and the next list re-probes anyway.
        format!(
            "UPDATE agent_setting \
             SET agent_type = '{quoted_builtin}', installed_version = NULL \
             WHERE agent_type = '{quoted_custom}' \
               AND NOT EXISTS (SELECT 1 FROM agent_setting WHERE agent_type = '{quoted_builtin}')"
        ),
        // When a `kiro` row already existed it keeps its own enabled flag and
        // order, but takes over the custom row's env and provider where it
        // has none — those are what a user typed and cannot re-derive.
        format!(
            "UPDATE agent_setting SET \
               env_json = COALESCE(env_json, \
                 (SELECT env_json FROM agent_setting WHERE agent_type = '{quoted_custom}')), \
               model_provider_id = COALESCE(model_provider_id, \
                 (SELECT model_provider_id FROM agent_setting WHERE agent_type = '{quoted_custom}')) \
             WHERE agent_type = '{quoted_builtin}'"
        ),
        format!("DELETE FROM agent_setting WHERE agent_type = '{quoted_custom}'"),
    ];
    for (table, column) in [
        ("opened_tab", "agent_type"),
        ("folder", "default_agent_type"),
        ("automation", "agent_type"),
        ("chat_channel_sender_context", "current_agent_type"),
        ("canvas_node", "agent_type"),
    ] {
        out.push(format!(
            "UPDATE {table} SET {column} = '{builtin}' WHERE {column} = '{custom}'"
        ));
    }
    // The quoted token is exact: it cannot match a longer id like
    // `custom:kiro-cli-beta`, and JSON never escapes `:` or `-`.
    for table in [
        "work_task",
        "work_task_settings",
        "work_task_template",
        "automation",
    ] {
        out.push(format!(
            "UPDATE {table} SET config = replace(config, '{quoted_custom}', '{quoted_builtin}') \
             WHERE instr(config, '{quoted_custom}') > 0"
        ));
    }
    out.push(format!(
        "DELETE FROM custom_agent WHERE registry_id = '{REGISTRY_ID}'"
    ));
    out
}

#[cfg(test)]
mod tests {
    use sea_orm::{ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement};
    use sea_orm_migration::MigratorTrait;

    use crate::db::migration::Migrator;

    fn sql(s: &str) -> Statement {
        Statement::from_string(DbBackend::Sqlite, s.to_owned())
    }

    async fn exec(conn: &DatabaseConnection, s: &str) {
        conn.execute(sql(s))
            .await
            .unwrap_or_else(|e| panic!("{s}: {e}"));
    }

    async fn strings(conn: &DatabaseConnection, query: &str) -> Vec<Option<String>> {
        conn.query_all(sql(query))
            .await
            .expect("query")
            .into_iter()
            .map(|row| row.try_get_by_index::<Option<String>>(0).expect("column"))
            .collect()
    }

    /// Apply every migration before this one, seed the shapes a user who
    /// registered `kiro-cli` as a custom agent really has (taken from such a
    /// database), then run the rest.
    async fn migrated_db(seed: &[&str]) -> DatabaseConnection {
        let conn = Database::connect("sqlite::memory:").await.expect("db");
        let migrations = <Migrator as MigratorTrait>::migrations();
        let idx = migrations
            .iter()
            .position(|m| m.name().contains("kiro_builtin_agent"))
            .expect("kiro migration is registered");
        Migrator::up(&conn, Some(idx as u32))
            .await
            .expect("earlier migrations");
        exec(
            &conn,
            "INSERT INTO folder (id, name, path, last_opened_at, created_at, updated_at, \
             is_open, sort_order, color, kind, default_agent_type) VALUES \
             (1, 'w', '/w', '2026-01-01', '2026-01-01', '2026-01-01', 1, 1, 'inherit', \
              'regular', 'custom:kiro-cli')",
        )
        .await;
        for statement in seed {
            exec(&conn, statement).await;
        }
        Migrator::up(&conn, None).await.expect("kiro migration");
        conn
    }

    const CONV: &str = "INSERT INTO conversation (id, folder_id, agent_type, status, \
                        message_count, title_locked, created_at, updated_at, external_id) VALUES ";
    const SETTING: &str = "INSERT INTO agent_setting (agent_type, registry_id, enabled, \
                           sort_order, installed_version, env_json, created_at, updated_at) VALUES ";
    const CUSTOM: &str = "INSERT INTO custom_agent (registry_id, name, description, version, \
                          distribution_kind, spec_json, created_at, updated_at) VALUES \
                          ('kiro-cli', 'Kiro', '', '2.24.1', 'binary', '{}', '2026-01-01', '2026-01-01'), \
                          ('goose', 'Goose', '', '1.0.0', 'binary', '{}', '2026-01-01', '2026-01-01')";

    #[tokio::test]
    async fn custom_kiro_becomes_the_builtin_everywhere() {
        let conn = migrated_db(&[
            &format!("{CONV}(1, 1, 'custom:kiro-cli', 'completed', 2, 0, '2026-01-01', '2026-01-01', 's1')"),
            &format!("{CONV}(2, 1, 'custom:goose', 'completed', 2, 0, '2026-01-01', '2026-01-01', 's2')"),
            &format!("{SETTING}('\"custom:kiro-cli\"', 'kiro-cli', 1, 17, 'kiro-cli 2.24.1', '{{\"K\":\"v\"}}', '2026-01-01', '2026-01-01')"),
            CUSTOM,
            "INSERT INTO opened_tab (folder_id, conversation_id, agent_type, position, is_active, \
             is_pinned, created_at, updated_at) VALUES (1, 1, 'custom:kiro-cli', 0, 1, 0, \
             '2026-01-01', '2026-01-01')",
            "INSERT INTO work_task_settings (folder_id, config, created_at, updated_at) VALUES \
             (1, '{\"default_agent_type\":\"custom:kiro-cli\",\"other\":\"custom:kiro-cli-beta\"}', \
             '2026-01-01', '2026-01-01')",
        ])
        .await;

        assert_eq!(
            strings(&conn, "SELECT agent_type FROM conversation ORDER BY id").await,
            [Some("kiro".into()), Some("custom:goose".into())]
        );
        // The settings row carries over (order, env) with the stale probe cleared.
        let rows = conn
            .query_all(sql(
                "SELECT agent_type, sort_order, installed_version, env_json FROM agent_setting",
            ))
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.try_get::<String>("", "agent_type").unwrap(), "\"kiro\"");
        assert_eq!(row.try_get::<i32>("", "sort_order").unwrap(), 17);
        assert_eq!(
            row.try_get::<Option<String>>("", "installed_version")
                .unwrap(),
            None
        );
        assert_eq!(
            row.try_get::<Option<String>>("", "env_json")
                .unwrap()
                .as_deref(),
            Some("{\"K\":\"v\"}")
        );
        assert_eq!(
            strings(&conn, "SELECT registry_id FROM custom_agent").await,
            [Some("goose".into())]
        );
        assert_eq!(
            strings(&conn, "SELECT agent_type FROM opened_tab").await,
            [Some("kiro".into())]
        );
        assert_eq!(
            strings(&conn, "SELECT default_agent_type FROM folder").await,
            [Some("kiro".into())]
        );
        // Only the exact quoted id is rewritten inside JSON.
        assert_eq!(
            strings(&conn, "SELECT config FROM work_task_settings").await,
            [Some(
                "{\"default_agent_type\":\"kiro\",\"other\":\"custom:kiro-cli-beta\"}".into()
            )]
        );
    }

    // Rows the built-in already has win, without losing anything: the
    // duplicate conversation is hidden and hands its tab to the built-in row,
    // and the built-in settings row inherits the custom env it lacked.
    #[tokio::test]
    async fn existing_builtin_rows_win_without_losing_data() {
        let conn = migrated_db(&[
            &format!("{CONV}(1, 1, 'custom:kiro-cli', 'completed', 2, 0, '2026-01-01', '2026-01-01', 'dup')"),
            &format!("{CONV}(2, 1, 'kiro', 'completed', 2, 0, '2026-01-01', '2026-01-01', 'dup')"),
            &format!("{CONV}(3, 1, 'custom:kiro-cli', 'completed', 2, 0, '2026-01-01', '2026-01-01', NULL)"),
            &format!("{SETTING}('\"custom:kiro-cli\"', 'kiro-cli', 0, 17, NULL, '{{\"KIRO_API_KEY\":\"k\"}}', '2026-01-01', '2026-01-01')"),
            &format!("{SETTING}('\"kiro\"', 'kiro-cli', 1, 3, NULL, NULL, '2026-01-01', '2026-01-01')"),
            "INSERT INTO opened_tab (folder_id, conversation_id, agent_type, position, is_active, \
             is_pinned, created_at, updated_at) VALUES (1, 1, 'custom:kiro-cli', 0, 1, 0, \
             '2026-01-01', '2026-01-01')",
        ])
        .await;

        assert_eq!(
            strings(&conn, "SELECT agent_type FROM conversation ORDER BY id").await,
            [
                Some("custom:kiro-cli".into()),
                Some("kiro".into()),
                Some("kiro".into())
            ]
        );
        assert_eq!(
            strings(
                &conn,
                "SELECT CASE WHEN deleted_at IS NULL THEN 'live' ELSE 'hidden' END \
                            FROM conversation ORDER BY id"
            )
            .await,
            [
                Some("hidden".into()),
                Some("live".into()),
                Some("live".into())
            ]
        );
        assert_eq!(
            strings(
                &conn,
                "SELECT conversation_id || ':' || agent_type FROM opened_tab"
            )
            .await,
            [Some("2:kiro".into())]
        );
        let rows = conn
            .query_all(sql(
                "SELECT agent_type, enabled, sort_order, env_json FROM agent_setting",
            ))
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].try_get::<String>("", "agent_type").unwrap(),
            "\"kiro\""
        );
        assert!(
            rows[0].try_get::<bool>("", "enabled").unwrap(),
            "built-in state kept"
        );
        assert_eq!(rows[0].try_get::<i32>("", "sort_order").unwrap(), 3);
        assert_eq!(
            rows[0]
                .try_get::<Option<String>>("", "env_json")
                .unwrap()
                .as_deref(),
            Some("{\"KIRO_API_KEY\":\"k\"}"),
            "custom env inherited"
        );
    }

    // Only Kiro moves: other built-ins, other custom agents and their
    // definitions are left exactly as they were.
    #[tokio::test]
    async fn other_agents_are_untouched() {
        let conn = migrated_db(&[
            &format!("{CONV}(1, 1, 'codex', 'completed', 2, 0, '2026-01-01', '2026-01-01', 's1')"),
            CUSTOM,
        ])
        .await;
        assert_eq!(
            strings(&conn, "SELECT agent_type FROM conversation").await,
            [Some("codex".into())]
        );
        assert_eq!(
            strings(&conn, "SELECT registry_id FROM custom_agent").await,
            [Some("goose".into())]
        );
    }
}
