use chrono::Utc;
use sea_orm::sea_query::OnConflict;
use sea_orm::{ActiveValue::NotSet, ColumnTrait, EntityTrait, QueryFilter, Set};
use sea_orm::{ConnectionTrait, DatabaseConnection};

use crate::db::entities::app_metadata;
use crate::db::error::DbError;

pub async fn upsert_value<C: ConnectionTrait>(
    conn: &C,
    key: &str,
    value: &str,
) -> Result<(), DbError> {
    let now = Utc::now();

    app_metadata::Entity::insert(app_metadata::ActiveModel {
        id: NotSet,
        key: Set(key.to_string()),
        value: Set(value.to_string()),
        created_at: Set(now),
        updated_at: Set(now),
        deleted_at: NotSet,
    })
    .on_conflict(
        OnConflict::column(app_metadata::Column::Key)
            .update_columns([app_metadata::Column::Value, app_metadata::Column::UpdatedAt])
            .to_owned(),
    )
    .exec(conn)
    .await?;

    Ok(())
}

pub async fn get_value(conn: &DatabaseConnection, key: &str) -> Result<Option<String>, DbError> {
    get_value_conn(conn, key).await
}

/// Remove `key`; a key that is not there is not an error.
pub async fn delete_value(conn: &DatabaseConnection, key: &str) -> Result<(), DbError> {
    app_metadata::Entity::delete_many()
        .filter(app_metadata::Column::Key.eq(key))
        .exec(conn)
        .await?;
    Ok(())
}

/// Generic-over-connection variant of [`get_value`] so callers can read a value
/// inside a transaction (`&DatabaseTransaction`) and compose it with a write.
pub async fn get_value_conn<C: ConnectionTrait>(
    conn: &C,
    key: &str,
) -> Result<Option<String>, DbError> {
    let model = app_metadata::Entity::find()
        .filter(app_metadata::Column::Key.eq(key))
        .filter(app_metadata::Column::DeletedAt.is_null())
        .one(conn)
        .await?;
    Ok(model.map(|m| m.value))
}

pub async fn update_app_version(
    conn: &DatabaseConnection,
    app_version: &str,
) -> Result<(), DbError> {
    let now = Utc::now();

    app_metadata::Entity::insert(app_metadata::ActiveModel {
        id: NotSet,
        key: Set("app_version".to_string()),
        value: Set(app_version.to_string()),
        created_at: Set(now),
        updated_at: Set(now),
        deleted_at: NotSet,
    })
    .on_conflict(
        OnConflict::column(app_metadata::Column::Key)
            .update_columns([app_metadata::Column::Value, app_metadata::Column::UpdatedAt])
            .to_owned(),
    )
    .exec(conn)
    .await?;

    app_metadata::Entity::insert(app_metadata::ActiveModel {
        id: NotSet,
        key: Set("db_initialized_at".to_string()),
        value: Set(now.to_rfc3339()),
        created_at: Set(now),
        updated_at: Set(now),
        deleted_at: NotSet,
    })
    .on_conflict(
        OnConflict::column(app_metadata::Column::Key)
            .do_nothing()
            .to_owned(),
    )
    .do_nothing()
    .exec(conn)
    .await?;

    Ok(())
}
