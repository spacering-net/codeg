//! Rounds of acceptance (7.5): one row per round, bound to the version it
//! checks — the task's run generation and the worktree's fingerprint — and
//! moved on only by conditional updates, so an old conclusion never lands on
//! a newer version.

use std::collections::HashMap;

use chrono::Utc;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait,
    ActiveValue::{NotSet, Set},
    ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder,
};

use crate::db::entities::personal_agent_verification::{
    self as round, AcceptDecision, CheckVerdict, DecidedBy, VerificationState,
};
use crate::db::error::DbError;

/// A round as it is opened.
#[derive(Debug, Clone)]
pub struct NewRound {
    pub bot_id: Option<i32>,
    pub dispatch_id: i32,
    pub round: i32,
    pub run_seq: i32,
    pub fingerprint: String,
    pub state: VerificationState,
    pub unchecked: bool,
}

pub async fn create(conn: &DatabaseConnection, new: NewRound) -> Result<round::Model, DbError> {
    let now = Utc::now();
    Ok(round::ActiveModel {
        id: NotSet,
        bot_id: Set(new.bot_id),
        dispatch_id: Set(new.dispatch_id),
        check_dispatch_id: Set(None),
        round: Set(new.round),
        run_seq: Set(new.run_seq),
        fingerprint: Set(new.fingerprint),
        state: Set(new.state),
        check_verdict: Set(None),
        check_evidence: Set(None),
        decision: Set(None),
        reason: Set(None),
        message: Set(None),
        question: Set(None),
        decided_by: Set(None),
        notice_id: Set(None),
        unchecked: Set(new.unchecked),
        delivered_head: Set(None),
        merge_commit: Set(None),
        version_guaranteed: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
        decided_at: Set(None),
    }
    .insert(conn)
    .await?)
}

pub async fn get(conn: &DatabaseConnection, id: i32) -> Result<Option<round::Model>, DbError> {
    Ok(round::Entity::find_by_id(id).one(conn).await?)
}

/// The round a check dispatch was sent out for.
pub async fn of_check(
    conn: &DatabaseConnection,
    check_dispatch_id: i32,
) -> Result<Option<round::Model>, DbError> {
    Ok(round::Entity::find()
        .filter(round::Column::CheckDispatchId.eq(check_dispatch_id))
        .one(conn)
        .await?)
}

/// The rounds the checks `check_ids` were sent out for, by check.
pub async fn of_checks(
    conn: &DatabaseConnection,
    check_ids: &[i32],
) -> Result<HashMap<i32, round::Model>, DbError> {
    if check_ids.is_empty() {
        return Ok(HashMap::new());
    }
    Ok(round::Entity::find()
        .filter(round::Column::CheckDispatchId.is_in(check_ids.to_vec()))
        .all(conn)
        .await?
        .into_iter()
        .filter_map(|r| r.check_dispatch_id.map(|c| (c, r)))
        .collect())
}

/// Every round of one piece of work, oldest first.
pub async fn rounds_of(
    conn: &DatabaseConnection,
    dispatch_id: i32,
) -> Result<Vec<round::Model>, DbError> {
    Ok(round::Entity::find()
        .filter(round::Column::DispatchId.eq(dispatch_id))
        .order_by_asc(round::Column::Id)
        .all(conn)
        .await?)
}

/// The latest round of each of `dispatch_ids` that has one.
pub async fn latest_of(
    conn: &DatabaseConnection,
    dispatch_ids: &[i32],
) -> Result<HashMap<i32, round::Model>, DbError> {
    if dispatch_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = round::Entity::find()
        .filter(round::Column::DispatchId.is_in(dispatch_ids.to_vec()))
        .order_by_asc(round::Column::Id)
        .all(conn)
        .await?;
    let mut out = HashMap::new();
    for r in rows {
        out.insert(r.dispatch_id, r);
    }
    Ok(out)
}

/// Every round of `bot` still waiting on a conclusion (any assistant's when
/// `None`).
pub async fn open_rounds(
    conn: &DatabaseConnection,
    bot: Option<i32>,
) -> Result<Vec<round::Model>, DbError> {
    let mut q = round::Entity::find().filter(round::Column::State.is_in([
        VerificationState::Checking,
        VerificationState::Deciding,
        VerificationState::Asked,
    ]));
    if let Some(b) = bot {
        q = q.filter(round::Column::BotId.eq(b));
    }
    Ok(q.order_by_asc(round::Column::Id).all(conn).await?)
}

/// What a move writes besides the state. `None` leaves a column as it is.
#[derive(Debug, Clone, Default)]
pub struct RoundWrite {
    pub check_dispatch_id: Option<Option<i32>>,
    pub run_seq: Option<i32>,
    pub check_verdict: Option<Option<CheckVerdict>>,
    pub check_evidence: Option<Option<String>>,
    pub decision: Option<Option<AcceptDecision>>,
    pub reason: Option<Option<String>>,
    pub message: Option<Option<String>>,
    pub question: Option<Option<String>>,
    pub decided_by: Option<Option<DecidedBy>>,
    pub notice_id: Option<Option<i32>>,
    pub delivered_head: Option<Option<String>>,
    pub merge_commit: Option<Option<String>>,
    pub version_guaranteed: Option<Option<bool>>,
    /// Stamp `decided_at` now.
    pub decided: bool,
}

/// The task generation a move is conditioned on: the task is still in
/// review at that run — checked in the same statement as the round's state,
/// so the two cannot drift apart between the check and the write.
#[derive(Debug, Clone, Copy)]
pub struct TaskAt {
    pub task_id: i32,
    pub run_seq: i32,
}

/// Move round `id` to `to` while it is in one of `from` (and, with `task`,
/// while that task is in review at that run). Returns the row when it moved.
pub async fn move_round(
    conn: &DatabaseConnection,
    id: i32,
    from: &[VerificationState],
    to: VerificationState,
    task: Option<TaskAt>,
    write: RoundWrite,
) -> Result<Option<round::Model>, DbError> {
    apply(conn, id, Some((from, to)), task, write).await
}

/// Write to round `id` whatever its state (what a merge or a delivery
/// records on a concluded round, the card it got).
pub async fn write_round(
    conn: &DatabaseConnection,
    id: i32,
    write: RoundWrite,
) -> Result<Option<round::Model>, DbError> {
    apply(conn, id, None, None, write).await
}

async fn apply(
    conn: &DatabaseConnection,
    id: i32,
    moving: Option<(&[VerificationState], VerificationState)>,
    task: Option<TaskAt>,
    write: RoundWrite,
) -> Result<Option<round::Model>, DbError> {
    let now = Utc::now();
    let mut update = round::Entity::update_many()
        .col_expr(round::Column::UpdatedAt, Expr::value(now))
        .filter(round::Column::Id.eq(id));
    if let Some((from, to)) = moving {
        update = update
            .col_expr(round::Column::State, Expr::value(to))
            .filter(round::Column::State.is_in(from.to_vec()));
    }
    if let Some(t) = task {
        update = update.filter(Expr::cust_with_values(
            "EXISTS (SELECT 1 FROM work_task WHERE work_task.id = ? AND work_task.status = 'review' \
             AND work_task.run_seq = ? AND work_task.deleted_at IS NULL)",
            [t.task_id, t.run_seq],
        ));
    }
    if let Some(v) = write.check_dispatch_id {
        update = update.col_expr(round::Column::CheckDispatchId, Expr::value(v));
    }
    if let Some(v) = write.run_seq {
        update = update.col_expr(round::Column::RunSeq, Expr::value(v));
    }
    if let Some(v) = write.check_verdict {
        update = update.col_expr(round::Column::CheckVerdict, Expr::value(v));
    }
    if let Some(v) = write.check_evidence {
        update = update.col_expr(round::Column::CheckEvidence, Expr::value(v));
    }
    if let Some(v) = write.decision {
        update = update.col_expr(round::Column::Decision, Expr::value(v));
    }
    if let Some(v) = write.reason {
        update = update.col_expr(round::Column::Reason, Expr::value(v));
    }
    if let Some(v) = write.message {
        update = update.col_expr(round::Column::Message, Expr::value(v));
    }
    if let Some(v) = write.question {
        update = update.col_expr(round::Column::Question, Expr::value(v));
    }
    if let Some(v) = write.decided_by {
        update = update.col_expr(round::Column::DecidedBy, Expr::value(v));
    }
    if let Some(v) = write.notice_id {
        update = update.col_expr(round::Column::NoticeId, Expr::value(v));
    }
    if let Some(v) = write.delivered_head {
        update = update.col_expr(round::Column::DeliveredHead, Expr::value(v));
    }
    if let Some(v) = write.merge_commit {
        update = update.col_expr(round::Column::MergeCommit, Expr::value(v));
    }
    if let Some(v) = write.version_guaranteed {
        update = update.col_expr(round::Column::VersionGuaranteed, Expr::value(v));
    }
    if write.decided {
        update = update.col_expr(round::Column::DecidedAt, Expr::value(Some(now)));
    }
    let res = update.exec(conn).await?;
    if res.rows_affected != 1 {
        return Ok(None);
    }
    get(conn, id).await
}
