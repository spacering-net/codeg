//! The two tables of Codeg Web's SRN sign-in (`srn::web`): sign-ins waiting
//! for the browser (`srn_web_logins`) and the browsers signed in
//! (`srn_web_sessions`). Hashes and sealed values come in already made: this
//! layer never sees a cookie, a state, a verifier or a token in the clear.

use chrono::{DateTime, Utc};
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::NotSet, ColumnTrait, ConnectionTrait, DeleteMany, EntityTrait, QueryFilter,
    QueryTrait, Set,
};

use crate::db::entities::{srn_web_login, srn_web_session};
use crate::db::error::DbError;

/// `delete`, as one `DELETE … RETURNING` statement: the rows it removed.
/// (SeaORM's own `exec_with_returning` needs a feature for SQLite that this
/// build leaves off; SQLite itself has had `RETURNING` since 3.35.)
async fn deleted<E: EntityTrait, C: ConnectionTrait>(
    conn: &C,
    delete: DeleteMany<E>,
) -> Result<Vec<E::Model>, DbError> {
    let mut query = delete.into_query();
    query.returning_all();
    let statement = conn.get_database_backend().build(&query);
    Ok(E::find().from_raw_sql(statement).all(conn).await?)
}

// ─── Sign-ins waiting for the browser ───────────────────────────────────

pub async fn insert_login<C: ConnectionTrait>(
    conn: &C,
    row: srn_web_login::Model,
) -> Result<(), DbError> {
    srn_web_login::Entity::insert(srn_web_login::ActiveModel {
        state_hash: Set(row.state_hash),
        flow_hash: Set(row.flow_hash),
        verifier: Set(row.verifier),
        request_id: Set(row.request_id),
        created_at: Set(row.created_at),
        expires_at: Set(row.expires_at),
    })
    .exec(conn)
    .await?;
    Ok(())
}

/// Removes the sign-ins a flow cookie was bound to: the one a new sign-in in
/// the same browser replaces.
pub async fn delete_logins_of_flows<C: ConnectionTrait>(
    conn: &C,
    flow_hashes: &[String],
) -> Result<u64, DbError> {
    if flow_hashes.is_empty() {
        return Ok(0);
    }
    let result = srn_web_login::Entity::delete_many()
        .filter(srn_web_login::Column::FlowHash.is_in(flow_hashes.iter().cloned()))
        .exec(conn)
        .await?;
    Ok(result.rows_affected)
}

/// Takes the sign-in whose state is `state_hash` and whose flow cookie is
/// one of `flow_hashes`, whatever its expiry (the caller checks it): one
/// `DELETE … RETURNING`, so of two callbacks racing for it only one gets it.
pub async fn claim_login<C: ConnectionTrait>(
    conn: &C,
    state_hash: &str,
    flow_hashes: &[String],
) -> Result<Option<srn_web_login::Model>, DbError> {
    if flow_hashes.is_empty() {
        return Ok(None);
    }
    let mut claimed = deleted(
        conn,
        srn_web_login::Entity::delete_many()
            .filter(srn_web_login::Column::StateHash.eq(state_hash))
            .filter(srn_web_login::Column::FlowHash.is_in(flow_hashes.iter().cloned())),
    )
    .await?;
    Ok(claimed.pop())
}

/// The newest sign-in still waiting for one of these flow cookies.
pub async fn find_live_login<C: ConnectionTrait>(
    conn: &C,
    flow_hashes: &[String],
    now: DateTime<Utc>,
) -> Result<Option<srn_web_login::Model>, DbError> {
    if flow_hashes.is_empty() {
        return Ok(None);
    }
    let rows = srn_web_login::Entity::find()
        .filter(srn_web_login::Column::FlowHash.is_in(flow_hashes.iter().cloned()))
        .all(conn)
        .await?;
    Ok(rows
        .into_iter()
        .filter(|row| row.expires_at > now)
        .max_by_key(|row| row.created_at))
}

pub async fn delete_expired_logins<C: ConnectionTrait>(
    conn: &C,
    now: DateTime<Utc>,
) -> Result<u64, DbError> {
    let result = srn_web_login::Entity::delete_many()
        .filter(srn_web_login::Column::ExpiresAt.lte(now))
        .exec(conn)
        .await?;
    Ok(result.rows_affected)
}

// ─── Browsers signed in ─────────────────────────────────────────────────

/// A new session, as its row is written (the ID is the database's).
pub struct NewSession {
    pub cookie_hash: String,
    pub srn: i64,
    pub display_name: String,
    pub avatar_path: Option<String>,
    pub connection_id: Option<String>,
    pub token: String,
    pub now: DateTime<Utc>,
    pub last_confirmed_at: Option<DateTime<Utc>>,
    pub check_problem: Option<String>,
    pub next_check_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

pub async fn insert_session<C: ConnectionTrait>(
    conn: &C,
    session: NewSession,
) -> Result<srn_web_session::Model, DbError> {
    let inserted = srn_web_session::Entity::insert(srn_web_session::ActiveModel {
        id: NotSet,
        cookie_hash: Set(session.cookie_hash),
        srn: Set(session.srn),
        display_name: Set(session.display_name),
        avatar_path: Set(session.avatar_path),
        connection_id: Set(session.connection_id),
        token: Set(session.token),
        created_at: Set(session.now),
        last_used_at: Set(session.now),
        last_checked_at: Set(session.now),
        last_confirmed_at: Set(session.last_confirmed_at),
        check_problem: Set(session.check_problem),
        next_check_at: Set(session.next_check_at),
        expires_at: Set(session.expires_at),
    })
    .exec_with_returning(conn)
    .await?;
    Ok(inserted)
}

/// The session one of these cookies names, expired or not (the caller
/// decides what an expired one means).
pub async fn find_session<C: ConnectionTrait>(
    conn: &C,
    cookie_hashes: &[String],
) -> Result<Option<srn_web_session::Model>, DbError> {
    if cookie_hashes.is_empty() {
        return Ok(None);
    }
    let rows = srn_web_session::Entity::find()
        .filter(srn_web_session::Column::CookieHash.is_in(cookie_hashes.iter().cloned()))
        .all(conn)
        .await?;
    Ok(rows.into_iter().max_by_key(|row| row.id))
}

/// Removes one session; the row, if it was still there.
pub async fn delete_session<C: ConnectionTrait>(
    conn: &C,
    id: i32,
) -> Result<Option<srn_web_session::Model>, DbError> {
    let mut removed = deleted(
        conn,
        srn_web_session::Entity::delete_many().filter(srn_web_session::Column::Id.eq(id)),
    )
    .await?;
    Ok(removed.pop())
}

/// Removes the sessions these cookies name; the rows removed.
pub async fn delete_sessions_of_cookies<C: ConnectionTrait>(
    conn: &C,
    cookie_hashes: &[String],
) -> Result<Vec<srn_web_session::Model>, DbError> {
    if cookie_hashes.is_empty() {
        return Ok(Vec::new());
    }
    deleted(
        conn,
        srn_web_session::Entity::delete_many()
            .filter(srn_web_session::Column::CookieHash.is_in(cookie_hashes.iter().cloned())),
    )
    .await
}

/// Removes every session whose time is up; the rows removed.
pub async fn delete_expired_sessions<C: ConnectionTrait>(
    conn: &C,
    now: DateTime<Utc>,
) -> Result<Vec<srn_web_session::Model>, DbError> {
    deleted(
        conn,
        srn_web_session::Entity::delete_many().filter(srn_web_session::Column::ExpiresAt.lte(now)),
    )
    .await
}

/// Records a use: the session lives another `expires_at`.
pub async fn touch_session<C: ConnectionTrait>(
    conn: &C,
    id: i32,
    now: DateTime<Utc>,
    expires_at: DateTime<Utc>,
) -> Result<(), DbError> {
    srn_web_session::Entity::update_many()
        .col_expr(srn_web_session::Column::LastUsedAt, Expr::value(now))
        .col_expr(srn_web_session::Column::ExpiresAt, Expr::value(expires_at))
        .filter(srn_web_session::Column::Id.eq(id))
        .exec(conn)
        .await?;
    Ok(())
}

/// Claims the session's online check, if it is due at `now`: moves
/// `next_check_at` to `hold_until`. Of several requests finding the same
/// check due, only one gets `true`; for the others it is no longer due.
pub async fn claim_check<C: ConnectionTrait>(
    conn: &C,
    id: i32,
    now: DateTime<Utc>,
    hold_until: DateTime<Utc>,
) -> Result<bool, DbError> {
    let result = srn_web_session::Entity::update_many()
        .col_expr(
            srn_web_session::Column::NextCheckAt,
            Expr::value(hold_until),
        )
        .filter(srn_web_session::Column::Id.eq(id))
        .filter(srn_web_session::Column::NextCheckAt.lte(now))
        .exec(conn)
        .await?;
    Ok(result.rows_affected == 1)
}

/// What an online check found.
pub struct CheckOutcome {
    pub checked_at: DateTime<Utc>,
    pub next_check_at: DateTime<Utc>,
    /// `Some` when SpaceRing confirmed the account: its identity now.
    pub confirmed: Option<(String, Option<String>)>,
    /// `Some` when it did not: why (the stored form).
    pub problem: Option<String>,
}

pub async fn record_check<C: ConnectionTrait>(
    conn: &C,
    id: i32,
    outcome: CheckOutcome,
) -> Result<(), DbError> {
    let mut update = srn_web_session::Entity::update_many()
        .col_expr(
            srn_web_session::Column::LastCheckedAt,
            Expr::value(outcome.checked_at),
        )
        .col_expr(
            srn_web_session::Column::NextCheckAt,
            Expr::value(outcome.next_check_at),
        )
        .col_expr(
            srn_web_session::Column::CheckProblem,
            Expr::value(outcome.problem),
        );
    if let Some((name, avatar)) = outcome.confirmed {
        update = update
            .col_expr(
                srn_web_session::Column::LastConfirmedAt,
                Expr::value(Some(outcome.checked_at)),
            )
            .col_expr(srn_web_session::Column::DisplayName, Expr::value(name))
            .col_expr(srn_web_session::Column::AvatarPath, Expr::value(avatar));
    }
    update
        .filter(srn_web_session::Column::Id.eq(id))
        .exec(conn)
        .await?;
    Ok(())
}
