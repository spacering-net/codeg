//! The owner's profile store (5.1, 2.11): one JSON value per key. What the
//! keys hold is the engine's (`personal_agent::profile`).

use chrono::{DateTime, Utc};
use sea_orm::sea_query::OnConflict;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder,
};
use serde_json::Value;

use crate::db::entities::personal_agent_profile as profile;
use crate::db::error::DbError;

/// The value under `key`; `None` when there is none (or it does not read).
pub async fn get(conn: &DatabaseConnection, key: &str) -> Result<Option<Value>, DbError> {
    Ok(profile::Entity::find_by_id(key.to_string())
        .one(conn)
        .await?
        .and_then(|m| serde_json::from_str(&m.data).ok()))
}

/// Write `value` under `key`.
pub async fn set(
    conn: &DatabaseConnection,
    key: &str,
    value: &Value,
    now: DateTime<Utc>,
) -> Result<(), DbError> {
    profile::Entity::insert(profile::ActiveModel {
        key: Set(key.to_string()),
        data: Set(value.to_string()),
        updated_at: Set(now),
    })
    .on_conflict(
        OnConflict::column(profile::Column::Key)
            .update_columns([profile::Column::Data, profile::Column::UpdatedAt])
            .to_owned(),
    )
    .exec(conn)
    .await?;
    Ok(())
}

/// Remove `key`.
pub async fn remove(conn: &DatabaseConnection, key: &str) -> Result<(), DbError> {
    profile::Entity::delete_by_id(key.to_string())
        .exec(conn)
        .await?;
    Ok(())
}

/// Every key starting with `prefix`, with its value, in key order.
pub async fn with_prefix(
    conn: &DatabaseConnection,
    prefix: &str,
) -> Result<Vec<(String, Value)>, DbError> {
    Ok(profile::Entity::find()
        .filter(profile::Column::Key.starts_with(prefix))
        .order_by_asc(profile::Column::Key)
        .all(conn)
        .await?
        .into_iter()
        .filter_map(|m| Some((m.key, serde_json::from_str(&m.data).ok()?)))
        .collect())
}

/// Remove every key starting with `prefix` that sorts before `before`.
pub async fn remove_with_prefix_before(
    conn: &DatabaseConnection,
    prefix: &str,
    before: &str,
) -> Result<u64, DbError> {
    Ok(profile::Entity::delete_many()
        .filter(profile::Column::Key.starts_with(prefix))
        .filter(profile::Column::Key.lt(before))
        .exec(conn)
        .await?
        .rows_affected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::fresh_in_memory_db;
    use serde_json::json;

    #[tokio::test]
    async fn a_key_holds_one_value_and_a_prefix_lists_and_prunes() {
        let db = fresh_in_memory_db().await;
        let now = Utc::now();
        assert_eq!(get(&db.conn, "hours").await.unwrap(), None);
        set(&db.conn, "hours", &json!({"a": 1}), now).await.unwrap();
        set(&db.conn, "hours", &json!({"a": 2}), now).await.unwrap();
        assert_eq!(get(&db.conn, "hours").await.unwrap(), Some(json!({"a": 2})));
        for day in ["2026-11-01", "2026-11-02", "2026-11-03"] {
            set(
                &db.conn,
                &format!("reach:{day}"),
                &json!({"merged": 1}),
                now,
            )
            .await
            .unwrap();
        }
        assert_eq!(with_prefix(&db.conn, "reach:").await.unwrap().len(), 3);
        assert_eq!(
            remove_with_prefix_before(&db.conn, "reach:", "reach:2026-11-03")
                .await
                .unwrap(),
            2
        );
        let left = with_prefix(&db.conn, "reach:").await.unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].0, "reach:2026-11-03");
        remove(&db.conn, "hours").await.unwrap();
        assert_eq!(get(&db.conn, "hours").await.unwrap(), None);
    }
}
