//! The morning briefs and the wrap-ups (6.4, 6.5): one row each, moved
//! from state to state by compare-and-swap, so two ticks — or a tick and a
//! turn ending — never both act on one.

use chrono::{DateTime, Utc};
use sea_orm::{
    ActiveModelTrait,
    ActiveValue::{NotSet, Set},
    ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
};

use super::personal_agent_service::is_unique_violation;
use crate::db::entities::personal_agent_brief as brief;
use crate::db::error::DbError;

pub const BRIEF: &str = "brief";
pub const WRAP: &str = "wrap";

pub const PREPARING: &str = "preparing";
pub const READY: &str = "ready";
pub const DELIVERED: &str = "delivered";
pub const EMPTY: &str = "empty";
pub const NATIVE: &str = "native";
pub const STOPPED: &str = "stopped";
pub const FAILED: &str = "failed";

/// A new one.
pub struct NewBrief {
    pub bot_id: i32,
    pub kind: &'static str,
    pub day: String,
    pub key: String,
    pub state: &'static str,
    pub since: DateTime<Utc>,
    pub material: Option<String>,
    pub batch_id: Option<i32>,
}

/// Write it; `None` when one with its key is there already.
pub async fn create(
    conn: &DatabaseConnection,
    new: NewBrief,
) -> Result<Option<brief::Model>, DbError> {
    let now = Utc::now();
    let ready = matches!(new.state, READY | NATIVE).then_some(now);
    let row = brief::ActiveModel {
        id: NotSet,
        bot_id: Set(new.bot_id),
        kind: Set(new.kind.to_string()),
        day: Set(new.day),
        key: Set(new.key),
        state: Set(new.state.to_string()),
        since: Set(new.since),
        material: Set(new.material),
        event_id: Set(None),
        batch_id: Set(new.batch_id),
        row_id: Set(None),
        tonight: Set(None),
        created_at: Set(now),
        ready_at: Set(ready),
        delivered_at: Set(None),
        updated_at: Set(now),
    };
    match row.insert(conn).await {
        Ok(m) => Ok(Some(m)),
        Err(e) if is_unique_violation(&e) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub async fn get(conn: &DatabaseConnection, id: i32) -> Result<Option<brief::Model>, DbError> {
    Ok(brief::Entity::find_by_id(id).one(conn).await?)
}

pub async fn by_key(
    conn: &DatabaseConnection,
    bot: i32,
    key: &str,
) -> Result<Option<brief::Model>, DbError> {
    Ok(brief::Entity::find()
        .filter(brief::Column::BotId.eq(bot))
        .filter(brief::Column::Key.eq(key))
        .one(conn)
        .await?)
}

/// The one a delivery writes.
pub async fn of_batch(
    conn: &DatabaseConnection,
    batch: i32,
) -> Result<Option<brief::Model>, DbError> {
    Ok(brief::Entity::find()
        .filter(brief::Column::BatchId.eq(batch))
        .order_by_desc(brief::Column::Id)
        .one(conn)
        .await?)
}

/// The one whose reply or card row is `row_id`.
pub async fn of_row(
    conn: &DatabaseConnection,
    row_id: i32,
) -> Result<Option<brief::Model>, DbError> {
    Ok(brief::Entity::find()
        .filter(brief::Column::RowId.eq(row_id))
        .order_by_desc(brief::Column::Id)
        .one(conn)
        .await?)
}

/// `bot`'s of `kind` for `day`, oldest first.
pub async fn of_day(
    conn: &DatabaseConnection,
    bot: i32,
    kind: &str,
    day: &str,
) -> Result<Vec<brief::Model>, DbError> {
    Ok(brief::Entity::find()
        .filter(brief::Column::BotId.eq(bot))
        .filter(brief::Column::Kind.eq(kind))
        .filter(brief::Column::Day.eq(day))
        .order_by_asc(brief::Column::Id)
        .all(conn)
        .await?)
}

/// `bot`'s latest of `kind` before `day` that said something (not empty).
pub async fn last_before(
    conn: &DatabaseConnection,
    bot: i32,
    kind: &str,
    day: &str,
) -> Result<Option<brief::Model>, DbError> {
    Ok(brief::Entity::find()
        .filter(brief::Column::BotId.eq(bot))
        .filter(brief::Column::Kind.eq(kind))
        .filter(brief::Column::Day.lt(day))
        .filter(brief::Column::State.ne(EMPTY))
        .order_by_desc(brief::Column::Id)
        .one(conn)
        .await?)
}

/// Those in `states`, oldest first.
pub async fn in_states(
    conn: &DatabaseConnection,
    states: &[&str],
) -> Result<Vec<brief::Model>, DbError> {
    Ok(brief::Entity::find()
        .filter(brief::Column::State.is_in(states.iter().map(|s| s.to_string())))
        .order_by_asc(brief::Column::Id)
        .all(conn)
        .await?)
}

/// The wrap-ups since `after` with something done tonight.
pub async fn wraps_with_tonight(
    conn: &DatabaseConnection,
    after: DateTime<Utc>,
) -> Result<Vec<brief::Model>, DbError> {
    Ok(brief::Entity::find()
        .filter(brief::Column::Kind.eq(WRAP))
        .filter(brief::Column::Tonight.is_not_null())
        .filter(brief::Column::CreatedAt.gte(after))
        .order_by_asc(brief::Column::Id)
        .limit(50)
        .all(conn)
        .await?)
}

/// What a move writes besides the state.
#[derive(Default)]
pub struct BriefWrite {
    pub event_id: Option<i32>,
    pub batch_id: Option<i32>,
    pub row_id: Option<i32>,
}

/// Move it from one of `from` to `to`: false when it was not in one of
/// them (someone else moved it first).
pub async fn swap_state(
    conn: &DatabaseConnection,
    id: i32,
    from: &[&str],
    to: &str,
    write: BriefWrite,
) -> Result<bool, DbError> {
    let now = Utc::now();
    let mut q = brief::Entity::update_many()
        .col_expr(brief::Column::State, sea_orm::sea_query::Expr::value(to))
        .col_expr(
            brief::Column::UpdatedAt,
            sea_orm::sea_query::Expr::value(now),
        );
    if matches!(to, READY | NATIVE) {
        q = q.col_expr(
            brief::Column::ReadyAt,
            sea_orm::sea_query::Expr::value(Some(now)),
        );
    }
    if to == DELIVERED {
        q = q.col_expr(
            brief::Column::DeliveredAt,
            sea_orm::sea_query::Expr::value(Some(now)),
        );
    }
    if let Some(e) = write.event_id {
        q = q.col_expr(
            brief::Column::EventId,
            sea_orm::sea_query::Expr::value(Some(e)),
        );
    }
    if let Some(b) = write.batch_id {
        q = q.col_expr(
            brief::Column::BatchId,
            sea_orm::sea_query::Expr::value(Some(b)),
        );
    }
    if let Some(r) = write.row_id {
        q = q.col_expr(
            brief::Column::RowId,
            sea_orm::sea_query::Expr::value(Some(r)),
        );
    }
    let res = q
        .filter(brief::Column::Id.eq(id))
        .filter(brief::Column::State.is_in(from.iter().map(|s| s.to_string())))
        .exec(conn)
        .await?;
    Ok(res.rows_affected > 0)
}

/// Record the event that wakes its assistant, the delivery that writes it.
pub async fn set_links(
    conn: &DatabaseConnection,
    id: i32,
    write: BriefWrite,
) -> Result<(), DbError> {
    let Some(had) = get(conn, id).await? else {
        return Ok(());
    };
    let mut a: brief::ActiveModel = had.into();
    if let Some(e) = write.event_id {
        a.event_id = Set(Some(e));
    }
    if let Some(b) = write.batch_id {
        a.batch_id = Set(Some(b));
    }
    if let Some(r) = write.row_id {
        a.row_id = Set(Some(r));
    }
    a.updated_at = Set(Utc::now());
    a.update(conn).await?;
    Ok(())
}

/// Replace what was had done tonight, if it is still `was`.
pub async fn swap_tonight(
    conn: &DatabaseConnection,
    id: i32,
    was: Option<&str>,
    now: &str,
) -> Result<bool, DbError> {
    let mut q = brief::Entity::update_many()
        .col_expr(
            brief::Column::Tonight,
            sea_orm::sea_query::Expr::value(Some(now.to_string())),
        )
        .col_expr(
            brief::Column::UpdatedAt,
            sea_orm::sea_query::Expr::value(Utc::now()),
        )
        .filter(brief::Column::Id.eq(id));
    q = match was {
        Some(w) => q.filter(brief::Column::Tonight.eq(w)),
        None => q.filter(brief::Column::Tonight.is_null()),
    };
    Ok(q.exec(conn).await?.rows_affected > 0)
}

/// Take back an event that has not been handed out yet (it is done, never
/// delivered): false when a delivery took it first.
pub async fn drop_pending_event(conn: &DatabaseConnection, event_id: i32) -> Result<bool, DbError> {
    use crate::db::entities::personal_agent_event::{self as event, EventState};
    let res = event::Entity::update_many()
        .col_expr(
            event::Column::State,
            sea_orm::sea_query::Expr::value(EventState::Done),
        )
        .col_expr(
            event::Column::UpdatedAt,
            sea_orm::sea_query::Expr::value(Utc::now()),
        )
        .filter(event::Column::Id.eq(event_id))
        .filter(event::Column::State.eq(EventState::Pending))
        .exec(conn)
        .await?;
    Ok(res.rows_affected > 0)
}
