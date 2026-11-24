use chrono::Utc;
use sea_orm::DatabaseConnection;
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ColumnTrait, ConnectionTrait, DbBackend, EntityTrait,
    IntoActiveModel, QueryFilter, QueryOrder, Set, Statement,
};

use crate::db::entities::folder_command;
use crate::db::error::DbError;
use crate::models::FolderCommandInfo;

fn to_info(m: folder_command::Model) -> FolderCommandInfo {
    FolderCommandInfo {
        id: m.id,
        folder_id: m.folder_id,
        name: m.name,
        command: m.command,
        sort_order: m.sort_order,
        run_local: m.run_local,
        created_at: m.created_at,
        updated_at: m.updated_at,
    }
}

pub async fn list_by_folder(
    conn: &DatabaseConnection,
    folder_id: i32,
) -> Result<Vec<FolderCommandInfo>, DbError> {
    let rows = folder_command::Entity::find()
        .filter(folder_command::Column::FolderId.eq(folder_id))
        .order_by_asc(folder_command::Column::SortOrder)
        .all(conn)
        .await?;

    Ok(rows.into_iter().map(to_info).collect())
}

pub async fn create(
    conn: &DatabaseConnection,
    folder_id: i32,
    name: &str,
    command: &str,
    run_local: bool,
) -> Result<FolderCommandInfo, DbError> {
    let now = Utc::now();

    // Get next sort_order
    let max_order = folder_command::Entity::find()
        .filter(folder_command::Column::FolderId.eq(folder_id))
        .order_by_desc(folder_command::Column::SortOrder)
        .one(conn)
        .await?
        .map(|m| m.sort_order)
        .unwrap_or(-1);

    let active = folder_command::ActiveModel {
        id: NotSet,
        folder_id: Set(folder_id),
        name: Set(name.to_string()),
        command: Set(command.to_string()),
        sort_order: Set(max_order + 1),
        run_local: Set(run_local),
        created_at: Set(now),
        updated_at: Set(now),
    };

    let model = active.insert(conn).await?;
    Ok(to_info(model))
}

pub async fn create_many(
    conn: &DatabaseConnection,
    folder_id: i32,
    items: &[(String, String)],
) -> Result<(), DbError> {
    if items.is_empty() {
        return Ok(());
    }

    let now = Utc::now();

    let max_order = folder_command::Entity::find()
        .filter(folder_command::Column::FolderId.eq(folder_id))
        .order_by_desc(folder_command::Column::SortOrder)
        .one(conn)
        .await?
        .map(|m| m.sort_order)
        .unwrap_or(-1);

    let active_models = items
        .iter()
        .enumerate()
        .map(|(idx, (name, command))| folder_command::ActiveModel {
            id: NotSet,
            folder_id: Set(folder_id),
            name: Set(name.clone()),
            command: Set(command.clone()),
            sort_order: Set(max_order + idx as i32 + 1),
            run_local: Set(false),
            created_at: Set(now),
            updated_at: Set(now),
        })
        .collect::<Vec<_>>();

    folder_command::Entity::insert_many(active_models)
        .exec(conn)
        .await?;

    Ok(())
}

/// Whether command `id` runs on the desktop's own machine; false when there is
/// no such command.
pub async fn is_run_local(conn: &DatabaseConnection, id: i32) -> Result<bool, DbError> {
    Ok(folder_command::Entity::find_by_id(id)
        .one(conn)
        .await?
        .is_some_and(|m| m.run_local))
}

pub async fn update(
    conn: &DatabaseConnection,
    id: i32,
    name: Option<String>,
    command: Option<String>,
    sort_order: Option<i32>,
    run_local: Option<bool>,
) -> Result<FolderCommandInfo, DbError> {
    let row = folder_command::Entity::find_by_id(id)
        .one(conn)
        .await?
        .ok_or_else(|| DbError::Migration(format!("FolderCommand {} not found", id)))?;

    let mut active = row.into_active_model();
    if let Some(n) = name {
        active.name = Set(n);
    }
    if let Some(c) = command {
        active.command = Set(c);
    }
    if let Some(s) = sort_order {
        active.sort_order = Set(s);
    }
    if let Some(r) = run_local {
        active.run_local = Set(r);
    }
    active.updated_at = Set(Utc::now());

    let model = active.update(conn).await?;
    Ok(to_info(model))
}

pub async fn delete(conn: &DatabaseConnection, id: i32) -> Result<(), DbError> {
    folder_command::Entity::delete_by_id(id).exec(conn).await?;
    Ok(())
}

pub async fn reorder(
    conn: &DatabaseConnection,
    folder_id: i32,
    ids: Vec<i32>,
) -> Result<(), DbError> {
    if ids.is_empty() {
        return Ok(());
    }

    let now = Utc::now();
    let now_str = now.format("%Y-%m-%d %H:%M:%S %:z").to_string();
    let case_expr = ids
        .iter()
        .enumerate()
        .map(|(idx, id)| format!("WHEN {} THEN {}", id, idx))
        .collect::<Vec<_>>()
        .join(" ");
    let id_list = ids
        .iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(", ");

    let sql = format!(
        "UPDATE folder_command SET sort_order = CASE id {case_expr} END, updated_at = '{now_str}' WHERE folder_id = {folder_id} AND id IN ({id_list})"
    );
    conn.execute(Statement::from_string(DbBackend::Sqlite, sql))
        .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::{fresh_in_memory_db, seed_folder};

    #[tokio::test]
    async fn keeps_where_a_command_runs() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/repo").await;

        let local = create(&db.conn, folder_id, "zed", "zed .", true)
            .await
            .unwrap();
        let terminal = create(&db.conn, folder_id, "dev", "pnpm dev", false)
            .await
            .unwrap();
        assert!(local.run_local);
        assert!(!terminal.run_local);

        // An update that doesn't mention it leaves it as it was.
        let renamed = update(&db.conn, local.id, Some("editor".into()), None, None, None)
            .await
            .unwrap();
        assert!(renamed.run_local);
        let listed = list_by_folder(&db.conn, folder_id).await.unwrap();
        assert_eq!(
            listed
                .iter()
                .map(|c| (c.name.as_str(), c.run_local))
                .collect::<Vec<_>>(),
            [("editor", true), ("dev", false)]
        );

        let in_a_terminal = update(&db.conn, local.id, None, None, None, Some(false))
            .await
            .unwrap();
        assert!(!in_a_terminal.run_local);
    }

    #[tokio::test]
    async fn package_scripts_run_in_a_terminal() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/repo").await;
        create_many(
            &db.conn,
            folder_id,
            &[("dev".to_string(), "pnpm run dev".to_string())],
        )
        .await
        .unwrap();
        let listed = list_by_folder(&db.conn, folder_id).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert!(!listed[0].run_local);
    }
}
