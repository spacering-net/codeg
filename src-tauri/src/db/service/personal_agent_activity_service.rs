//! When the owner was in codeg (1.12): minutes active per local day and
//! five-minute slot, the account's. Written by the presence heartbeat, read
//! to learn the owner's usual hours, kept [`KEEP_DAYS`] days.

use chrono::{DateTime, NaiveDate, Utc};
use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{
    ActiveValue::{NotSet, Set},
    ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder,
};

use crate::db::entities::personal_agent_activity as activity;
use crate::db::error::DbError;

/// How long the record is kept.
pub const KEEP_DAYS: i64 = 60;

fn day_key(day: NaiveDate) -> String {
    day.format("%Y-%m-%d").to_string()
}

/// One more active minute in `slot` of `day`.
pub async fn add_minute(
    conn: &DatabaseConnection,
    day: NaiveDate,
    slot: u32,
    now: DateTime<Utc>,
) -> Result<(), DbError> {
    activity::Entity::insert(activity::ActiveModel {
        id: NotSet,
        day: Set(day_key(day)),
        slot: Set(slot as i32),
        count: Set(1),
        updated_at: Set(now),
    })
    .on_conflict(
        OnConflict::columns([activity::Column::Day, activity::Column::Slot])
            .value(
                activity::Column::Count,
                Expr::col((activity::Entity, activity::Column::Count)).add(1),
            )
            .value(activity::Column::UpdatedAt, Expr::value(now))
            .to_owned(),
    )
    .exec(conn)
    .await?;
    Ok(())
}

/// Every slot from `from` on, oldest first: `(day, slot, minutes)`.
pub async fn since(
    conn: &DatabaseConnection,
    from: NaiveDate,
) -> Result<Vec<(NaiveDate, u32, u32)>, DbError> {
    let rows = activity::Entity::find()
        .filter(activity::Column::Day.gte(day_key(from)))
        .order_by_asc(activity::Column::Day)
        .order_by_asc(activity::Column::Slot)
        .all(conn)
        .await?;
    Ok(rows
        .into_iter()
        .filter_map(|r| {
            let day = NaiveDate::parse_from_str(&r.day, "%Y-%m-%d").ok()?;
            let slot = u32::try_from(r.slot).ok()?;
            let count = u32::try_from(r.count).ok()?;
            Some((day, slot, count))
        })
        .collect())
}

/// Forget every day (the owner cleared what codeg learned, 5.3).
pub async fn clear(conn: &DatabaseConnection) -> Result<u64, DbError> {
    Ok(activity::Entity::delete_many()
        .exec(conn)
        .await?
        .rows_affected)
}

/// Forget the days before `keep_from`.
pub async fn prune(conn: &DatabaseConnection, keep_from: NaiveDate) -> Result<u64, DbError> {
    let res = activity::Entity::delete_many()
        .filter(activity::Column::Day.lt(day_key(keep_from)))
        .exec(conn)
        .await?;
    Ok(res.rows_affected)
}
