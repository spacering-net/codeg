use std::path::{Path, PathBuf};

use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait, IntoActiveModel, QueryFilter,
    QueryOrder, Set,
};

use crate::acp::agent_accounts::layout;
use crate::db::entities::agent_account::{self, Entity};
use crate::db::error::DbError;
use crate::models::AgentType;

pub async fn list(
    conn: &impl ConnectionTrait,
    agent: AgentType,
) -> Result<Vec<agent_account::Model>, DbError> {
    Ok(Entity::find()
        .filter(agent_account::Column::AgentType.eq(agent.as_wire().as_ref()))
        .filter(agent_account::Column::Removed.eq(false))
        .order_by_asc(agent_account::Column::CreatedAt)
        .all(conn)
        .await?)
}

pub async fn list_all(conn: &impl ConnectionTrait) -> Result<Vec<agent_account::Model>, DbError> {
    Ok(Entity::find()
        .filter(agent_account::Column::Removed.eq(false))
        .order_by_asc(agent_account::Column::CreatedAt)
        .all(conn)
        .await?)
}

pub async fn list_for_display(
    conn: &impl ConnectionTrait,
    agent: AgentType,
) -> Result<Vec<agent_account::Model>, DbError> {
    Ok(Entity::find()
        .filter(agent_account::Column::AgentType.eq(agent.as_wire().as_ref()))
        .order_by_asc(agent_account::Column::CreatedAt)
        .all(conn)
        .await?)
}

pub async fn get(conn: &impl ConnectionTrait, id: &str) -> Result<agent_account::Model, DbError> {
    Entity::find_by_id(id).one(conn).await?.ok_or_else(|| {
        DbError::NotFound(
            "This agent account is no longer available. Add it again in Settings > Agents.".into(),
        )
    })
}

pub async fn resolve(
    conn: &impl ConnectionTrait,
    agent: AgentType,
    id: &str,
) -> Result<agent_account::Model, DbError> {
    let account = get(conn, id).await?;
    if account.agent_type != agent.as_wire() {
        return Err(DbError::Validation(
            "Choose an account for the selected agent.".into(),
        ));
    }
    if account.removed {
        return Err(DbError::Validation(format!(
            "This account was removed. To continue, add its folder {} again in Settings > Agents.",
            account.home_dir
        )));
    }
    if !Path::new(&account.home_dir).is_dir() {
        return Err(DbError::Validation(format!(
            "The account folder {} is missing. Restore it before resuming this conversation.",
            account.home_dir
        )));
    }
    Ok(account)
}

/// A persisted conversation, including a removed-account binding, is the
/// authority on reconnect. A stale client cannot switch its subscription.
pub async fn connection_account(
    conn: &impl ConnectionTrait,
    agent: AgentType,
    requested: Option<String>,
    conversation_id: Option<i32>,
) -> Result<Option<String>, DbError> {
    let Some(id) = conversation_id else {
        return Ok(requested);
    };
    let row = crate::db::entities::conversation::Entity::find_by_id(id)
        .one(conn)
        .await?
        .ok_or_else(|| DbError::NotFound("Conversation not found".into()))?;
    if row.agent_type != agent.as_wire() {
        return Err(DbError::Validation(
            "This conversation belongs to a different agent.".into(),
        ));
    }
    if requested
        .as_ref()
        .is_some_and(|id| row.agent_account_id.as_ref() != Some(id))
    {
        return Err(DbError::Validation(
            "This conversation belongs to a different agent account.".into(),
        ));
    }
    Ok(row.agent_account_id)
}

fn checked_name(name: &str) -> Result<String, DbError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err(DbError::Validation(
            "Use an account name between 1 and 80 characters.".into(),
        ));
    }
    Ok(name.to_owned())
}

pub async fn create(
    conn: &impl ConnectionTrait,
    data_dir: &Path,
    agent: AgentType,
    name: &str,
    existing_home: Option<&str>,
) -> Result<agent_account::Model, DbError> {
    if let Some(reason) = crate::acp::agent_accounts::unsupported_reason(agent) {
        return Err(DbError::Validation(reason.into()));
    }
    let spec = layout(agent).ok_or_else(|| {
        DbError::Validation("This agent does not support isolated accounts.".into())
    })?;
    let name = checked_name(name)?;
    let accounts = list(conn, agent).await?;
    if accounts
        .iter()
        .any(|a| a.name.to_lowercase() == name.to_lowercase())
    {
        return Err(DbError::Validation(
            "An account with this name already exists.".into(),
        ));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let home = match existing_home {
        Some(raw) => {
            let home = PathBuf::from(raw.trim());
            if !home.is_absolute() || !home.is_dir() {
                return Err(DbError::Validation(
                    "Choose an existing account folder using its absolute path.".into(),
                ));
            }
            home.canonicalize()?
        }
        None => {
            let home = data_dir.join("agent-accounts").join(&id);
            std::fs::create_dir_all(spec.config_dir(&home))?;
            home.canonicalize()?
        }
    };
    if accounts
        .iter()
        .any(|a| Path::new(&a.home_dir).canonicalize().ok().as_ref() == Some(&home))
    {
        return Err(DbError::Validation(
            "This folder is already used by another account.".into(),
        ));
    }
    let setting = super::agent_setting_service::get_by_agent_type(conn, agent).await?;
    let native = crate::commands::acp::load_agent_local_config_json(agent);
    let default_env = crate::commands::acp::build_runtime_env_from_setting(
        agent,
        setting.as_ref(),
        native.as_deref(),
    );
    if crate::acp::agent_accounts::aliases_default_account(agent, &home, &default_env) {
        return Err(DbError::Validation(
            "This folder belongs to the default account. Choose a separate account folder.".into(),
        ));
    }
    if existing_home.is_some() {
        if let Some(removed) = removed_account_at(conn, agent, &home).await? {
            let mut model = removed.into_active_model();
            model.name = Set(name);
            model.removed = Set(false);
            model.updated_at = Set(Utc::now());
            return Ok(model.update(conn).await?);
        }
    }
    #[cfg(unix)]
    if existing_home.is_none() {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700))?;
    }
    // Windows verbatim prefixes are valid Rust paths but several native CLIs
    // cannot open them. Persist the normalized, ordinary absolute spelling.
    let home_dir = ordinary_path(&home);
    let now = Utc::now();
    Ok(agent_account::ActiveModel {
        id: Set(id),
        agent_type: Set(agent.as_wire().into_owned()),
        name: Set(name),
        home_dir: Set(home_dir),
        removed: Set(false),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(conn)
    .await?)
}

pub async fn rename(conn: &impl ConnectionTrait, id: &str, name: &str) -> Result<(), DbError> {
    let account = get(conn, id).await?;
    if account.removed {
        return Err(DbError::Validation("This account was removed.".into()));
    }
    let name = checked_name(name)?;
    let agent = AgentType::from_wire(&account.agent_type)
        .ok_or_else(|| DbError::Validation("Unknown agent.".into()))?;
    if list(conn, agent)
        .await?
        .iter()
        .any(|a| a.id != id && a.name.to_lowercase() == name.to_lowercase())
    {
        return Err(DbError::Validation(
            "An account with this name already exists.".into(),
        ));
    }
    let mut model = account.into_active_model();
    model.name = Set(name);
    model.updated_at = Set(Utc::now());
    model.update(conn).await?;
    Ok(())
}

/// A removed account of `agent` kept in `home` (canonical). Adding that folder
/// again brings the account back under its own id: its saved conversations are
/// bound to that id, so a new one would leave them unable to continue.
async fn removed_account_at(
    conn: &impl ConnectionTrait,
    agent: AgentType,
    home: &Path,
) -> Result<Option<agent_account::Model>, DbError> {
    Ok(Entity::find()
        .filter(agent_account::Column::AgentType.eq(agent.as_wire().as_ref()))
        .filter(agent_account::Column::Removed.eq(true))
        .order_by_desc(agent_account::Column::UpdatedAt)
        .all(conn)
        .await?
        .into_iter()
        .find(|a| Path::new(&a.home_dir).canonicalize().ok().as_deref() == Some(home)))
}

/// Removing an account never deletes files or reassigns its conversations.
pub async fn remove(conn: &impl ConnectionTrait, id: &str) -> Result<(), DbError> {
    let mut model = get(conn, id).await?.into_active_model();
    model.removed = Set(true);
    model.updated_at = Set(Utc::now());
    model.update(conn).await?;
    Ok(())
}

fn ordinary_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{unc}");
        }
        if let Some(drive) = value.strip_prefix(r"\\?\") {
            return drive.to_owned();
        }
    }
    value.into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::fresh_in_memory_db;

    fn migrations_from_fixture(names: &str) -> Vec<Box<dyn sea_orm_migration::MigrationTrait>> {
        use sea_orm_migration::MigratorTrait;

        let expected: std::collections::HashSet<_> = names
            .lines()
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .collect();
        let selected: Vec<_> = crate::db::migration::Migrator::migrations()
            .into_iter()
            .filter(|migration| expected.contains(migration.name()))
            .collect();
        assert_eq!(
            selected.len(),
            expected.len(),
            "a prior migration ID was removed"
        );
        selected
    }

    #[tokio::test]
    async fn unsupported_accounts_are_refused_before_creating_folders_or_rows() {
        let db = fresh_in_memory_db().await;
        let dir = tempfile::tempdir().unwrap();
        for capability in crate::acp::agent_accounts::capabilities() {
            if capability.supported {
                continue;
            }
            let error = create(&db.conn, dir.path(), capability.agent_type, "Work", None)
                .await
                .unwrap_err();
            assert!(error.to_string().contains(capability.reason.unwrap()));
            assert!(!dir.path().join("agent-accounts").exists());
            assert!(list(&db.conn, capability.agent_type)
                .await
                .unwrap()
                .is_empty());
        }
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn existing_cursor_account_records_and_folders_remain_available() {
        let db = fresh_in_memory_db().await;
        let dir = tempfile::tempdir().unwrap();
        let account = create(&db.conn, dir.path(), AgentType::Codex, "Existing", None)
            .await
            .unwrap();
        let mut existing = account.clone().into_active_model();
        existing.agent_type = Set(AgentType::Cursor.as_wire().into_owned());
        existing.update(&db.conn).await.unwrap();
        let resolved = resolve(&db.conn, AgentType::Cursor, &account.id)
            .await
            .unwrap();
        assert_eq!(resolved.home_dir, account.home_dir);
        assert!(Path::new(&resolved.home_dir).is_dir());
        assert!(crate::acp::agent_accounts::isolation_env(
            AgentType::Cursor,
            Path::new(&resolved.home_dir)
        )
        .is_err());
        assert_eq!(list(&db.conn, AgentType::Cursor).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn crud_keeps_homes_and_refuses_removed_or_wrong_family_accounts() {
        let db = fresh_in_memory_db().await;
        let dir = tempfile::tempdir().unwrap();
        let account = create(&db.conn, dir.path(), AgentType::Codex, "Work", None)
            .await
            .unwrap();
        assert_eq!(list(&db.conn, AgentType::Codex).await.unwrap().len(), 1);
        assert!(create(&db.conn, dir.path(), AgentType::Codex, "work", None)
            .await
            .is_err());
        assert!(create(
            &db.conn,
            dir.path(),
            AgentType::Codex,
            "Other",
            Some(&account.home_dir)
        )
        .await
        .is_err());
        assert!(resolve(&db.conn, AgentType::ClaudeCode, &account.id)
            .await
            .is_err());
        rename(&db.conn, &account.id, "Personal").await.unwrap();
        assert_eq!(get(&db.conn, &account.id).await.unwrap().name, "Personal");
        remove(&db.conn, &account.id).await.unwrap();
        assert!(list(&db.conn, AgentType::Codex).await.unwrap().is_empty());
        assert!(Path::new(&account.home_dir).is_dir());
        assert!(resolve(&db.conn, AgentType::Codex, &account.id)
            .await
            .is_err());
        assert!(get(&db.conn, &account.id).await.is_ok());
    }

    /// Removal keeps the folder and the conversations bound to the account.
    /// Adding that folder again must bring back the same account; a new id
    /// left those conversations bound to a removed one, unable to continue.
    #[tokio::test]
    async fn re_adding_a_removed_folder_restores_its_account() {
        use crate::db::entities::conversation::ConversationKind;
        use crate::db::service::conversation_service;
        let db = fresh_in_memory_db().await;
        let dir = tempfile::tempdir().unwrap();
        let folder =
            crate::db::test_helpers::seed_folder(&db, &dir.path().display().to_string()).await;
        let account = create(&db.conn, dir.path(), AgentType::Codex, "Work", None)
            .await
            .unwrap();
        let row = conversation_service::create_inner(
            &db.conn,
            folder,
            AgentType::Codex,
            None,
            None,
            None,
            ConversationKind::Regular,
            Some(account.id.clone()),
        )
        .await
        .unwrap();
        remove(&db.conn, &account.id).await.unwrap();
        let refused = resolve(&db.conn, AgentType::Codex, &account.id)
            .await
            .unwrap_err()
            .to_string();
        assert!(refused.contains(&account.home_dir), "{refused}");

        // Another agent's account in the same folder is its own account.
        let claude = create(
            &db.conn,
            dir.path(),
            AgentType::ClaudeCode,
            "Claude",
            Some(&account.home_dir),
        )
        .await
        .unwrap();
        assert_ne!(claude.id, account.id);

        let restored = create(
            &db.conn,
            dir.path(),
            AgentType::Codex,
            "Work again",
            Some(&format!("{}/", account.home_dir)),
        )
        .await
        .unwrap();
        assert_eq!(restored.id, account.id);
        assert_eq!(restored.name, "Work again");
        assert!(!restored.removed);
        assert_eq!(list(&db.conn, AgentType::Codex).await.unwrap().len(), 1);
        resolve(&db.conn, AgentType::Codex, &account.id)
            .await
            .unwrap();
        assert_eq!(
            connection_account(&db.conn, AgentType::Codex, None, Some(row.id))
                .await
                .unwrap(),
            Some(account.id.clone())
        );
        assert!(create(
            &db.conn,
            dir.path(),
            AgentType::Codex,
            "Twice",
            Some(&account.home_dir)
        )
        .await
        .is_err());
        // A new folder is a new account.
        let fresh = create(&db.conn, dir.path(), AgentType::Codex, "Fresh", None)
            .await
            .unwrap();
        assert_ne!(fresh.id, account.id);
    }

    #[tokio::test]
    async fn missing_home_never_falls_back_to_default() {
        let db = fresh_in_memory_db().await;
        let dir = tempfile::tempdir().unwrap();
        let account = create(&db.conn, dir.path(), AgentType::Codex, "Work", None)
            .await
            .unwrap();
        std::fs::remove_dir(&account.home_dir).unwrap();
        let missing = resolve(&db.conn, AgentType::Codex, &account.id)
            .await
            .unwrap_err();
        assert!(missing.to_string().contains(&account.home_dir));
    }

    #[tokio::test]
    async fn saved_bindings_survive_removal_and_reject_account_switches() {
        use crate::db::entities::conversation::ConversationKind;
        use crate::db::service::conversation_service;
        let db = fresh_in_memory_db().await;
        let dir = tempfile::tempdir().unwrap();
        let folder =
            crate::db::test_helpers::seed_folder(&db, &dir.path().display().to_string()).await;
        let a = create(&db.conn, dir.path(), AgentType::Codex, "A", None)
            .await
            .unwrap();
        let b = create(&db.conn, dir.path(), AgentType::Codex, "B", None)
            .await
            .unwrap();
        let row = conversation_service::create_inner(
            &db.conn,
            folder,
            AgentType::Codex,
            None,
            None,
            None,
            ConversationKind::Regular,
            Some(a.id.clone()),
        )
        .await
        .unwrap();
        assert_eq!(
            connection_account(&db.conn, AgentType::Codex, None, Some(row.id))
                .await
                .unwrap(),
            Some(a.id.clone())
        );
        let other_account =
            connection_account(&db.conn, AgentType::Codex, Some(b.id.clone()), Some(row.id))
                .await
                .unwrap_err()
                .to_string();
        assert!(
            other_account.contains("belongs to a different agent account."),
            "{other_account}"
        );
        // Another agent is not another account of this one: say which it is.
        let other_agent = connection_account(&db.conn, AgentType::ClaudeCode, None, Some(row.id))
            .await
            .unwrap_err()
            .to_string();
        assert!(
            other_agent.contains("belongs to a different agent."),
            "{other_agent}"
        );
        remove(&db.conn, &a.id).await.unwrap();
        assert_eq!(
            connection_account(&db.conn, AgentType::Codex, None, Some(row.id))
                .await
                .unwrap(),
            Some(a.id.clone())
        );
        assert!(resolve(&db.conn, AgentType::Codex, &a.id).await.is_err());
        assert!(list_for_display(&db.conn, AgentType::Codex)
            .await
            .unwrap()
            .iter()
            .any(|account| account.id == a.id && account.removed));
    }

    #[tokio::test]
    async fn migration_preserves_existing_rows_and_scopes_session_identity() {
        use crate::db::entities::conversation;
        use crate::db::migration::Migrator;
        use crate::db::service::{conversation_service, folder_service};
        use sea_orm::{Database, DbBackend, Statement};
        use sea_orm_migration::{MigratorTrait, SchemaManager};
        let conn = Database::connect("sqlite::memory:").await.unwrap();
        let migrations = Migrator::migrations();
        let account_migration = migrations
            .iter()
            .position(|migration| migration.name() == "m20261017_000001_agent_account")
            .expect("native account migration is registered");
        Migrator::up(&conn, Some(account_migration as u32))
            .await
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let folder = folder_service::add_folder(&conn, &dir.path().display().to_string())
            .await
            .unwrap();
        conn.execute(Statement::from_sql_and_values(DbBackend::Sqlite,
            "INSERT INTO conversation (folder_id, agent_type, status, kind, title_locked, external_id, message_count, created_at, updated_at) VALUES (?, 'codex', 'pending_review', 'regular', 0, 'shared-session', 0, '2026-10-11T00:00:00Z', '2026-10-11T00:00:00Z')",
            [folder.id.into()])).await.unwrap();
        Migrator::up(&conn, None).await.unwrap();
        let old = conversation::Entity::find()
            .one(&conn)
            .await
            .unwrap()
            .unwrap();
        assert!(old.agent_account_id.is_none());
        let account = create(&conn, dir.path(), AgentType::Codex, "Work", None)
            .await
            .unwrap();
        let named = conversation_service::create_inner(
            &conn,
            folder.id,
            AgentType::Codex,
            None,
            None,
            None,
            conversation::ConversationKind::Regular,
            Some(account.id.clone()),
        )
        .await
        .unwrap();
        conversation_service::bind_external_id(&conn, named.id, "shared-session", &[])
            .await
            .unwrap();
        assert_eq!(
            conversation::Entity::find().all(&conn).await.unwrap().len(),
            2
        );
        assert!(
            conversation_service::find_live_by_session_ref(&conn, "shared-session")
                .await
                .is_err()
        );
        assert_eq!(
            conversation_service::find_live_by_session_ref(&conn, &named.id.to_string())
                .await
                .unwrap()
                .unwrap()
                .agent_account_id,
            Some(account.id)
        );
        // Later migrations must not change which rollback guard this tests.
        let error = migrations[account_migration]
            .down(&SchemaManager::new(&conn))
            .await
            .expect_err("bound accounts must prevent their migration's rollback");
        assert!(error.to_string().contains("Cannot remove account bindings"));
        assert!(conversation::Entity::find_by_id(named.id)
            .one(&conn)
            .await
            .unwrap()
            .unwrap()
            .agent_account_id
            .is_some());
    }

    #[test]
    fn account_backup_marker_follows_released_migrations() {
        use crate::db::migration::Migrator;
        use sea_orm_migration::MigratorTrait;

        // Keep the original account migration ID for existing PR databases.
        // The later marker makes v0.40 refuse this schema's backups. The
        // registry's feature_schema_marker_is_last test also guards its tail.
        let names: Vec<String> = Migrator::migrations()
            .iter()
            .map(|migration| migration.name().to_string())
            .collect();
        let position = |name: &str| names.iter().position(|n| n == name).expect(name);
        assert!(
            position("m20261027_000001_agent_account_compatibility")
                > position("m20261022_000001_work_task_delivery")
        );
        position("m20261017_000001_agent_account");
        position("m20261024_000001_agent_account_compatibility");
    }

    #[tokio::test]
    async fn account_migration_can_follow_newer_release_migrations() {
        use crate::db::migration::Migrator;
        use sea_orm::{Database, DbBackend, Statement};
        use sea_orm_migration::{MigrationTrait, MigratorTrait, SchemaManager};

        // The immutable release fixture excludes all pending PR migrations,
        // including handoff tables and markers when this test runs in that stack.
        struct ReleasedSchema;
        #[async_trait::async_trait]
        impl MigratorTrait for ReleasedSchema {
            fn migrations() -> Vec<Box<dyn MigrationTrait>> {
                migrations_from_fixture(include_str!("../../../tests/fixtures/v040-migrations.txt"))
            }
        }

        let conn = Database::connect("sqlite::memory:").await.unwrap();
        ReleasedSchema::up(&conn, None).await.unwrap();
        let folder = crate::db::service::folder_service::add_folder(&conn, "/released-project")
            .await
            .unwrap();
        conn.execute(Statement::from_sql_and_values(DbBackend::Sqlite,
            "INSERT INTO conversation (folder_id, agent_type, status, kind, title_locked, external_id, message_count, created_at, updated_at) VALUES (?, 'codex', 'pending_review', 'regular', 0, 'released-session', 0, '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z')",
            [folder.id.into()])).await.unwrap();

        Migrator::up(&conn, None).await.unwrap();
        let schema = SchemaManager::new(&conn);
        assert!(schema
            .has_column("conversation", "assistant_id")
            .await
            .unwrap());
        assert!(schema.has_column("conversation", "source").await.unwrap());
        assert!(schema.has_table("tool_approval").await.unwrap());
        assert!(schema
            .has_column("folder_command", "run_local")
            .await
            .unwrap());
        assert!(schema
            .has_column("conversation", "agent_account_id")
            .await
            .unwrap());
        let saved = crate::db::entities::conversation::Entity::find()
            .one(&conn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(saved.external_id.as_deref(), Some("released-session"));
        assert!(saved.agent_account_id.is_none());
    }

    async fn verify_previous_account_schema<M: sea_orm_migration::MigratorTrait>() {
        use crate::db::entities::conversation;
        use crate::db::migration::Migrator;
        use crate::db::service::{conversation_service, folder_service};
        use sea_orm::{Database, DbBackend, Statement};
        use sea_orm_migration::MigratorTrait;

        let conn = Database::connect("sqlite::memory:").await.unwrap();
        M::up(&conn, None).await.unwrap();
        let dir = tempfile::tempdir().unwrap();
        let folder = folder_service::add_folder(&conn, "/previous-project")
            .await
            .unwrap();
        let account = create(&conn, dir.path(), AgentType::Codex, "Work", None)
            .await
            .unwrap();
        let named = conversation_service::create_inner(
            &conn,
            folder.id,
            AgentType::Codex,
            None,
            None,
            None,
            conversation::ConversationKind::Regular,
            Some(account.id.clone()),
        )
        .await
        .unwrap();
        conversation_service::bind_external_id(&conn, named.id, "previous-session", &[])
            .await
            .unwrap();
        conn.execute(Statement::from_sql_and_values(
            DbBackend::Sqlite,
            "INSERT INTO folder_command (folder_id, name, command, created_at, updated_at) VALUES (?, 'Existing command', 'echo fixture', '2026-10-18T00:00:00Z', '2026-10-18T00:00:00Z')",
            [folder.id.into()],
        )).await.unwrap();

        Migrator::up(&conn, None).await.unwrap();
        let saved = conversation::Entity::find_by_id(named.id)
            .one(&conn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(saved.agent_account_id.as_deref(), Some(account.id.as_str()));
        assert_eq!(saved.external_id.as_deref(), Some("previous-session"));
        let saved_account = get(&conn, &account.id).await.unwrap();
        assert_eq!(saved_account.home_dir, account.home_dir);
        assert_eq!(saved_account.name, account.name);
        let command = conn
            .query_one(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT command, run_local FROM folder_command".to_owned(),
            ))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            command.try_get::<String>("", "command").unwrap(),
            "echo fixture"
        );
        assert_eq!(command.try_get::<i32>("", "run_local").unwrap(), 0);
        let applied: Vec<String> = conn
            .query_all(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT version FROM seaql_migrations".to_owned(),
            ))
            .await
            .unwrap()
            .into_iter()
            .map(|row| row.try_get("", "version").unwrap())
            .collect();
        for previous in M::migrations() {
            assert!(applied.iter().any(|name| name == previous.name()));
        }
        assert!(applied
            .iter()
            .any(|name| name == "m20261024_000001_agent_account_compatibility"));
        assert!(applied
            .iter()
            .any(|name| name == "m20261027_000001_agent_account_compatibility"));
    }

    #[tokio::test]
    async fn previous_account_schema_upgrades_without_renaming_or_losing_bindings() {
        use sea_orm_migration::{MigrationTrait, MigratorTrait};
        struct PreviousSchema;
        #[async_trait::async_trait]
        impl MigratorTrait for PreviousSchema {
            fn migrations() -> Vec<Box<dyn MigrationTrait>> {
                migrations_from_fixture(include_str!(
                    "../../../tests/fixtures/native-account-migrations-20261018.txt"
                ))
            }
        }
        verify_previous_account_schema::<PreviousSchema>().await;
    }

    #[tokio::test]
    async fn previous_compatibility_marker_schema_upgrades_without_renaming_or_losing_bindings() {
        use sea_orm_migration::{MigrationTrait, MigratorTrait};
        struct PreviousSchema;
        #[async_trait::async_trait]
        impl MigratorTrait for PreviousSchema {
            fn migrations() -> Vec<Box<dyn MigrationTrait>> {
                migrations_from_fixture(include_str!(
                    "../../../tests/fixtures/native-account-migrations-20261021.txt"
                ))
            }
        }
        verify_previous_account_schema::<PreviousSchema>().await;
    }

    #[tokio::test]
    async fn october_24_account_schema_keeps_bindings_and_old_migration_ids() {
        use sea_orm_migration::{MigrationTrait, MigratorTrait};
        struct PreviousSchema;
        #[async_trait::async_trait]
        impl MigratorTrait for PreviousSchema {
            fn migrations() -> Vec<Box<dyn MigrationTrait>> {
                migrations_from_fixture(include_str!(
                    "../../../tests/fixtures/native-account-migrations-20261024.txt"
                ))
            }
        }
        verify_previous_account_schema::<PreviousSchema>().await;
    }
}
