//! "Is this right?" (10.3): the checks of messages the owner asked for.
//!
//! A check and the dispatch that carries it out are written in one
//! transaction: there is never a dispatch whose news nobody routes to its
//! check, nor a check waiting on a dispatch that was never made. A check
//! settles once, by a conditional update from `checking`.

use chrono::{DateTime, Utc};
use sea_orm::{
    ActiveModelTrait,
    ActiveValue::{NotSet, Set},
    ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder, TransactionTrait,
};

use super::personal_agent_service::{self as svc, NewDispatch};
use crate::db::entities::personal_agent_check::{self as check, FactCheckState, FactVerdict};
use crate::db::entities::personal_agent_dispatch as dispatch;
use crate::db::error::DbError;

fn clock_now() -> DateTime<Utc> {
    crate::personal_agent::clock::now()
}

/// A check to make.
#[derive(Debug, Clone)]
pub struct NewCheck {
    pub bot_id: i32,
    pub conversation_id: i32,
    pub message_fp: String,
    pub quote_fp: String,
    pub message: String,
    pub quote: Option<String>,
    pub asked: Option<String>,
}

/// Write a check and the dispatch that carries it out, as one.
pub async fn create_with_dispatch(
    conn: &DatabaseConnection,
    new: NewCheck,
    work: NewDispatch,
) -> Result<(check::Model, dispatch::Model), DbError> {
    let txn = conn.begin().await?;
    let d = svc::create_dispatch_on(&txn, work).await?;
    let now = clock_now();
    let made = check::ActiveModel {
        id: NotSet,
        bot_id: Set(new.bot_id),
        conversation_id: Set(new.conversation_id),
        message_fp: Set(new.message_fp),
        quote_fp: Set(new.quote_fp),
        message: Set(new.message),
        quote: Set(new.quote),
        asked: Set(new.asked),
        state: Set(FactCheckState::Checking),
        verdict: Set(None),
        evidence: Set(None),
        note: Set(None),
        dispatch_id: Set(Some(d.id)),
        notice_id: Set(None),
        told_at: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(&txn)
    .await?;
    txn.commit().await?;
    Ok((made, d))
}

pub async fn get(conn: &DatabaseConnection, id: i32) -> Result<Option<check::Model>, DbError> {
    Ok(check::Entity::find_by_id(id).one(conn).await?)
}

/// The check dispatch `dispatch_id` carries out.
pub async fn of_dispatch(
    conn: &DatabaseConnection,
    dispatch_id: i32,
) -> Result<Option<check::Model>, DbError> {
    Ok(check::Entity::find()
        .filter(check::Column::DispatchId.eq(dispatch_id))
        .one(conn)
        .await?)
}

/// The latest check of this message (and this sentence of it).
pub async fn latest_for(
    conn: &DatabaseConnection,
    conversation_id: i32,
    message_fp: &str,
    quote_fp: &str,
) -> Result<Option<check::Model>, DbError> {
    Ok(check::Entity::find()
        .filter(check::Column::ConversationId.eq(conversation_id))
        .filter(check::Column::MessageFp.eq(message_fp))
        .filter(check::Column::QuoteFp.eq(quote_fp))
        .order_by_desc(check::Column::Id)
        .one(conn)
        .await?)
}

/// The latest check of each message (and sentence) of a conversation,
/// oldest first.
pub async fn latest_of_conversation(
    conn: &DatabaseConnection,
    conversation_id: i32,
) -> Result<Vec<check::Model>, DbError> {
    let all = check::Entity::find()
        .filter(check::Column::ConversationId.eq(conversation_id))
        .order_by_desc(check::Column::Id)
        .all(conn)
        .await?;
    let mut seen = std::collections::HashSet::new();
    let mut latest: Vec<check::Model> = all
        .into_iter()
        .filter(|c| seen.insert((c.message_fp.clone(), c.quote_fp.clone())))
        .collect();
    latest.reverse();
    Ok(latest)
}

/// Its card.
pub async fn set_notice(conn: &DatabaseConnection, id: i32, notice_id: i32) -> Result<(), DbError> {
    check::Entity::update_many()
        .col_expr(
            check::Column::NoticeId,
            sea_orm::sea_query::Expr::value(notice_id),
        )
        .filter(check::Column::Id.eq(id))
        .exec(conn)
        .await?;
    Ok(())
}

/// How a check ended.
#[derive(Debug, Clone)]
pub struct Settled {
    pub state: FactCheckState,
    pub verdict: Option<FactVerdict>,
    pub evidence: Option<String>,
    pub note: Option<String>,
}

/// Settle a check that is still checking: `None` when something settled
/// it first.
pub async fn settle(
    conn: &DatabaseConnection,
    id: i32,
    end: Settled,
) -> Result<Option<check::Model>, DbError> {
    use sea_orm::sea_query::Expr;
    let done = check::Entity::update_many()
        .col_expr(check::Column::State, Expr::value(end.state))
        .col_expr(check::Column::Verdict, Expr::value(end.verdict))
        .col_expr(check::Column::Evidence, Expr::value(end.evidence))
        .col_expr(check::Column::Note, Expr::value(end.note))
        .col_expr(check::Column::UpdatedAt, Expr::value(clock_now()))
        .filter(check::Column::Id.eq(id))
        .filter(check::Column::State.eq(FactCheckState::Checking))
        .exec(conn)
        .await?;
    if done.rows_affected == 0 {
        return Ok(None);
    }
    get(conn, id).await
}

/// `bot`'s checks still checking.
pub async fn checking_of_bot(
    conn: &DatabaseConnection,
    bot: i32,
) -> Result<Vec<check::Model>, DbError> {
    Ok(check::Entity::find()
        .filter(check::Column::BotId.eq(bot))
        .filter(check::Column::State.eq(FactCheckState::Checking))
        .order_by_asc(check::Column::Id)
        .all(conn)
        .await?)
}

/// What check `id` came to was told.
pub async fn mark_told(conn: &DatabaseConnection, id: i32) -> Result<(), DbError> {
    check::Entity::update_many()
        .col_expr(
            check::Column::ToldAt,
            sea_orm::sea_query::Expr::value(Some(clock_now())),
        )
        .filter(check::Column::Id.eq(id))
        .exec(conn)
        .await?;
    Ok(())
}

/// `bot`'s checks that ended before `before` and what they came to was not
/// all told (a restart cut it short).
pub async fn untold_of_bot(
    conn: &DatabaseConnection,
    bot: i32,
    before: DateTime<Utc>,
) -> Result<Vec<check::Model>, DbError> {
    Ok(check::Entity::find()
        .filter(check::Column::BotId.eq(bot))
        .filter(check::Column::State.ne(FactCheckState::Checking))
        .filter(check::Column::ToldAt.is_null())
        .filter(check::Column::UpdatedAt.lt(before))
        .order_by_asc(check::Column::Id)
        .all(conn)
        .await?)
}
