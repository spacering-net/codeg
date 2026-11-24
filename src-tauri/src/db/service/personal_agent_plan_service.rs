//! Plans (7.6): each assistant's own, and their steps.
//!
//! Only the owning assistant's engine carries a plan out. A plan and its
//! steps are made in one transaction — with the ledger entry of the call
//! that laid it out, so a re-delivered turn makes nothing twice. Every move
//! of a step or a plan is a conditional update on the state it moves from:
//! two hands on the same step (a hook and the clock's look) cannot both
//! start it, and an owner's stop is not undone by a late completion.

use chrono::{DateTime, Utc};
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait,
    ActiveValue::{NotSet, Set},
    ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder,
    TransactionTrait,
};

use super::personal_agent_service::{colliding_entry, is_unique_violation, LedgerSlot, Ledgered};
use crate::db::entities::personal_agent_action::{self as action, ActionState};
use crate::db::entities::personal_agent_plan::{self as plan, PlanState};
use crate::db::entities::personal_agent_plan_step::{self as step, StepState, TargetKind};
use crate::db::error::DbError;

fn clock_now() -> DateTime<Utc> {
    crate::personal_agent::clock::now()
}

/// A plan to make.
#[derive(Debug, Clone)]
pub struct NewPlan {
    pub bot_id: i32,
    pub title: String,
    pub goal: Option<String>,
    pub state: PlanState,
    pub origin_batch_id: Option<i32>,
    pub for_input: Option<String>,
    pub origin_bot_id: Option<i32>,
    pub origin_row_id: Option<i32>,
    pub thread_id: Option<i32>,
}

/// A step to make (or a step's content to write).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct NewStep {
    pub seq: i32,
    pub title: String,
    pub target_kind: TargetKind,
    pub target_id: i32,
    pub target_name: String,
    pub mode: Option<String>,
    pub project_id: Option<i32>,
    pub deliverable: Option<String>,
    pub prompt: String,
    pub done_when: Option<String>,
    pub depends_on: Vec<i32>,
    pub confirmed: bool,
}

impl NewStep {
    /// A step's content as it stands.
    pub fn of(s: &step::Model) -> Self {
        Self {
            seq: s.seq,
            title: s.title.clone(),
            target_kind: s.target_kind,
            target_id: s.target_id,
            target_name: s.target_name.clone(),
            mode: s.mode.clone(),
            project_id: s.project_id,
            deliverable: s.deliverable.clone(),
            prompt: s.prompt.clone(),
            done_when: s.done_when.clone(),
            depends_on: s.deps(),
            confirmed: s.confirmed,
        }
    }
}

fn step_active(plan_id: i32, s: NewStep, now: DateTime<Utc>) -> step::ActiveModel {
    step::ActiveModel {
        id: NotSet,
        plan_id: Set(plan_id),
        seq: Set(s.seq),
        title: Set(s.title),
        target_kind: Set(s.target_kind),
        target_id: Set(s.target_id),
        target_name: Set(s.target_name),
        mode: Set(s.mode),
        project_id: Set(s.project_id),
        deliverable: Set(s.deliverable),
        prompt: Set(s.prompt),
        done_when: Set(s.done_when),
        depends_on: Set(serde_json::to_string(&s.depends_on).unwrap_or_else(|_| "[]".into())),
        state: Set(StepState::Pending),
        confirmed: Set(s.confirmed),
        dispatch_id: Set(None),
        message_id: Set(None),
        attempt: Set(0),
        failures: Set(0),
        result: Set(None),
        error: Set(None),
        started_at: Set(None),
        ended_at: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
    }
}

/// The ledger entry of a call on a plan, in the caller's transaction.
async fn ledger_entry<C: ConnectionTrait>(
    conn: &C,
    bot: i32,
    slot: &LedgerSlot,
    plan_id: i32,
    payload: Option<serde_json::Value>,
    now: DateTime<Utc>,
) -> Result<(), sea_orm::DbErr> {
    action::ActiveModel {
        id: NotSet,
        bot_id: Set(Some(bot)),
        batch_id: Set(slot.batch_id),
        key: Set(slot.key.clone()),
        kind: Set("plan".into()),
        state: Set(ActionState::Committed),
        ref_id: Set(Some(plan_id.to_string())),
        created_at: Set(now),
        updated_at: Set(now),
        op_id: Set(Some(slot.op_id.clone())),
        payload: Set(payload.map(|p| p.to_string())),
        observed: Set(None),
        target: Set(None),
        notice_id: Set(None),
        attempted_at: Set(None),
        detail: Set(None),
    }
    .insert(conn)
    .await
    .map(|_| ())
}

/// A step's content and state an update writes, when it is still in one
/// of `from`.
#[derive(Debug, Clone)]
pub struct StepUpdate {
    pub id: i32,
    pub from: Vec<StepState>,
    pub write: StepWrite,
}

/// What a `plan_update` writes, all at once.
#[derive(Debug, Clone, Default)]
pub struct PlanUpdate {
    pub removed: Vec<(i32, Vec<StepState>)>,
    pub updated: Vec<StepUpdate>,
    pub added: Vec<NewStep>,
    pub plan: PlanWrite,
}

/// Write a plan's change — steps removed, changed and added, the plan
/// itself, and the ledger entry of the call — in one transaction: all of it
/// or none. A step that moved meanwhile undoes it all (`Ok(None)`).
pub async fn apply_update(
    conn: &DatabaseConnection,
    bot: i32,
    plan_id: i32,
    u: PlanUpdate,
    slot: Option<&LedgerSlot>,
    payload: Option<serde_json::Value>,
) -> Result<Option<Ledgered<()>>, DbError> {
    let now = clock_now();
    let txn = conn.begin().await?;
    for (id, from) in &u.removed {
        if !delete_step(&txn, *id, from).await? {
            txn.rollback().await?;
            return Ok(None);
        }
    }
    for s in u.updated {
        if update_step(&txn, s.id, Some(&s.from), s.write)
            .await?
            .is_none()
        {
            txn.rollback().await?;
            return Ok(None);
        }
    }
    for s in u.added {
        step_active(plan_id, s, now).insert(&txn).await?;
    }
    if update(&txn, plan_id, None, u.plan).await?.is_none() {
        txn.rollback().await?;
        return Ok(None);
    }
    if let Some(slot) = slot {
        match ledger_entry(&txn, bot, slot, plan_id, payload, now).await {
            Ok(()) => {}
            Err(e) if is_unique_violation(&e) => {
                txn.rollback().await?;
                return Ok(Some(Ledgered::Earlier(Box::new(
                    colliding_entry(conn, slot).await?,
                ))));
            }
            Err(e) => {
                let _ = txn.rollback().await;
                return Err(e.into());
            }
        }
    }
    txn.commit().await?;
    Ok(Some(Ledgered::New(())))
}

/// Make a plan and its steps — with the ledger entry of the call that laid
/// it out, when there is one — in one transaction.
pub async fn create(
    conn: &DatabaseConnection,
    new: NewPlan,
    steps: Vec<NewStep>,
    slot: Option<&LedgerSlot>,
    payload: Option<serde_json::Value>,
) -> Result<Ledgered<plan::Model>, DbError> {
    let now = clock_now();
    let bot = new.bot_id;
    let txn = conn.begin().await?;
    let made = plan::ActiveModel {
        id: NotSet,
        bot_id: Set(new.bot_id),
        title: Set(new.title),
        goal: Set(new.goal),
        state: Set(new.state),
        notice_id: Set(None),
        origin_batch_id: Set(new.origin_batch_id),
        for_input: Set(new.for_input),
        origin_bot_id: Set(new.origin_bot_id),
        origin_row_id: Set(new.origin_row_id),
        thread_id: Set(new.thread_id),
        stuck_reason: Set(None),
        changes: Set("[]".into()),
        told: Set(None),
        started_at: Set((new.state == PlanState::Running).then_some(now)),
        ended_at: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(&txn)
    .await?;
    for s in steps {
        step_active(made.id, s, now).insert(&txn).await?;
    }
    if let Some(slot) = slot {
        match ledger_entry(&txn, bot, slot, made.id, payload, now).await {
            Ok(()) => {}
            Err(e) if is_unique_violation(&e) => {
                txn.rollback().await?;
                return Ok(Ledgered::Earlier(Box::new(
                    colliding_entry(conn, slot).await?,
                )));
            }
            Err(e) => {
                let _ = txn.rollback().await;
                return Err(e.into());
            }
        }
    }
    txn.commit().await?;
    Ok(Ledgered::New(made))
}

pub async fn get<C: ConnectionTrait>(conn: &C, id: i32) -> Result<Option<plan::Model>, DbError> {
    Ok(plan::Entity::find_by_id(id).one(conn).await?)
}

/// One of `bot`'s plans.
pub async fn get_of(
    conn: &DatabaseConnection,
    bot: i32,
    id: i32,
) -> Result<Option<plan::Model>, DbError> {
    Ok(plan::Entity::find_by_id(id)
        .filter(plan::Column::BotId.eq(bot))
        .one(conn)
        .await?)
}

/// The plan whose card is `notice_id`.
pub async fn of_notice(
    conn: &DatabaseConnection,
    notice_id: i32,
) -> Result<Option<plan::Model>, DbError> {
    Ok(plan::Entity::find()
        .filter(plan::Column::NoticeId.eq(notice_id))
        .one(conn)
        .await?)
}

/// `bot`'s plans in these states, oldest first.
pub async fn of_bot(
    conn: &DatabaseConnection,
    bot: i32,
    states: &[PlanState],
) -> Result<Vec<plan::Model>, DbError> {
    Ok(plan::Entity::find()
        .filter(plan::Column::BotId.eq(bot))
        .filter(plan::Column::State.is_in(states.iter().copied()))
        .order_by_asc(plan::Column::Id)
        .all(conn)
        .await?)
}

/// `bot`'s plans that ended since `since`, newest first.
pub async fn ended_since(
    conn: &DatabaseConnection,
    bot: i32,
    since: DateTime<Utc>,
) -> Result<Vec<plan::Model>, DbError> {
    Ok(plan::Entity::find()
        .filter(plan::Column::BotId.eq(bot))
        .filter(plan::Column::State.is_in([PlanState::Done, PlanState::Canceled]))
        .filter(plan::Column::EndedAt.gte(since))
        .order_by_desc(plan::Column::Id)
        .all(conn)
        .await?)
}

/// `bot`'s plans that are done and still owe what their end owes (the
/// summary asked for, the owner told): however long ago they ended.
pub async fn done_untold(conn: &DatabaseConnection, bot: i32) -> Result<Vec<plan::Model>, DbError> {
    use sea_orm::Condition;
    Ok(plan::Entity::find()
        .filter(plan::Column::BotId.eq(bot))
        .filter(plan::Column::State.eq(PlanState::Done))
        .filter(
            Condition::any()
                .add(plan::Column::Told.is_null())
                .add(plan::Column::Told.not_like("%\"done\":true%")),
        )
        .order_by_asc(plan::Column::Id)
        .all(conn)
        .await?)
}

/// What to write on a plan; `None` leaves a field.
#[derive(Debug, Clone, Default)]
pub struct PlanWrite {
    pub title: Option<String>,
    pub goal: Option<Option<String>>,
    pub state: Option<PlanState>,
    pub notice_id: Option<Option<i32>>,
    pub stuck_reason: Option<Option<String>>,
    pub changes: Option<String>,
    pub told: Option<Option<String>>,
    pub started_at: Option<Option<DateTime<Utc>>>,
    pub ended_at: Option<Option<DateTime<Utc>>>,
}

/// Write on a plan, when it is in one of `from` (any, when `None`). The
/// plan as written; `None` when its state moved meanwhile.
pub async fn update<C: ConnectionTrait>(
    conn: &C,
    id: i32,
    from: Option<&[PlanState]>,
    w: PlanWrite,
) -> Result<Option<plan::Model>, DbError> {
    let mut q = plan::Entity::update_many().filter(plan::Column::Id.eq(id));
    if let Some(from) = from {
        q = q.filter(plan::Column::State.is_in(from.iter().copied()));
    }
    macro_rules! set {
        ($field:ident, $col:ident) => {
            if let Some(v) = w.$field {
                q = q.col_expr(plan::Column::$col, Expr::value(v));
            }
        };
    }
    set!(title, Title);
    set!(goal, Goal);
    if let Some(s) = w.state {
        q = q.col_expr(plan::Column::State, Expr::value(s));
    }
    set!(notice_id, NoticeId);
    set!(stuck_reason, StuckReason);
    set!(changes, Changes);
    set!(told, Told);
    set!(started_at, StartedAt);
    set!(ended_at, EndedAt);
    q = q.col_expr(plan::Column::UpdatedAt, Expr::value(clock_now()));
    let res = q.exec(conn).await?;
    if res.rows_affected == 0 {
        return Ok(None);
    }
    get(conn, id).await
}

/// A plan's steps, in their order.
pub async fn steps_of(
    conn: &DatabaseConnection,
    plan_id: i32,
) -> Result<Vec<step::Model>, DbError> {
    Ok(step::Entity::find()
        .filter(step::Column::PlanId.eq(plan_id))
        .order_by_asc(step::Column::Seq)
        .all(conn)
        .await?)
}

pub async fn get_step<C: ConnectionTrait>(
    conn: &C,
    id: i32,
) -> Result<Option<step::Model>, DbError> {
    Ok(step::Entity::find_by_id(id).one(conn).await?)
}

/// The step a dispatch carries out.
pub async fn step_of_dispatch(
    conn: &DatabaseConnection,
    dispatch_id: i32,
) -> Result<Option<step::Model>, DbError> {
    Ok(step::Entity::find()
        .filter(step::Column::DispatchId.eq(dispatch_id))
        .order_by_desc(step::Column::Id)
        .one(conn)
        .await?)
}

/// The step a message to a work assistant carries out.
pub async fn step_of_message(
    conn: &DatabaseConnection,
    message_id: i32,
) -> Result<Option<step::Model>, DbError> {
    Ok(step::Entity::find()
        .filter(step::Column::MessageId.eq(message_id))
        .order_by_desc(step::Column::Id)
        .one(conn)
        .await?)
}

/// Steps of live plans handed to `target` (a work assistant or an executor
/// config) that have not started or are under way.
pub async fn steps_for_target(
    conn: &DatabaseConnection,
    kind: TargetKind,
    target: i32,
) -> Result<Vec<step::Model>, DbError> {
    Ok(step::Entity::find()
        .filter(step::Column::TargetKind.eq(kind))
        .filter(step::Column::TargetId.eq(target))
        .filter(step::Column::State.is_in([StepState::Pending, StepState::Running]))
        .order_by_asc(step::Column::Id)
        .all(conn)
        .await?)
}

/// What to write on a step; `None` leaves a field.
#[derive(Debug, Clone, Default)]
pub struct StepWrite {
    pub content: Option<NewStep>,
    pub state: Option<StepState>,
    pub confirmed: Option<bool>,
    pub dispatch_id: Option<Option<i32>>,
    pub message_id: Option<Option<i32>>,
    pub bump_attempt: bool,
    pub bump_failures: bool,
    pub result: Option<Option<String>>,
    pub error: Option<Option<String>>,
    pub started_at: Option<Option<DateTime<Utc>>>,
    pub ended_at: Option<Option<DateTime<Utc>>>,
}

/// Write on a step, when it is in one of `from` (any, when `None`). The
/// step as written; `None` when its state moved meanwhile.
pub async fn update_step<C: ConnectionTrait>(
    conn: &C,
    id: i32,
    from: Option<&[StepState]>,
    w: StepWrite,
) -> Result<Option<step::Model>, DbError> {
    let mut q = step::Entity::update_many().filter(step::Column::Id.eq(id));
    if let Some(from) = from {
        q = q.filter(step::Column::State.is_in(from.iter().copied()));
    }
    if let Some(c) = w.content {
        q = q
            .col_expr(step::Column::Title, Expr::value(c.title))
            .col_expr(step::Column::TargetKind, Expr::value(c.target_kind))
            .col_expr(step::Column::TargetId, Expr::value(c.target_id))
            .col_expr(step::Column::TargetName, Expr::value(c.target_name))
            .col_expr(step::Column::Mode, Expr::value(c.mode))
            .col_expr(step::Column::ProjectId, Expr::value(c.project_id))
            .col_expr(step::Column::Deliverable, Expr::value(c.deliverable))
            .col_expr(step::Column::Prompt, Expr::value(c.prompt))
            .col_expr(step::Column::DoneWhen, Expr::value(c.done_when))
            .col_expr(
                step::Column::DependsOn,
                Expr::value(serde_json::to_string(&c.depends_on).unwrap_or_else(|_| "[]".into())),
            )
            .col_expr(step::Column::Confirmed, Expr::value(c.confirmed));
    }
    if let Some(s) = w.state {
        q = q.col_expr(step::Column::State, Expr::value(s));
    }
    macro_rules! set {
        ($field:ident, $col:ident) => {
            if let Some(v) = w.$field {
                q = q.col_expr(step::Column::$col, Expr::value(v));
            }
        };
    }
    set!(confirmed, Confirmed);
    set!(dispatch_id, DispatchId);
    set!(message_id, MessageId);
    set!(result, Result);
    set!(error, Error);
    set!(started_at, StartedAt);
    set!(ended_at, EndedAt);
    if w.bump_attempt {
        q = q.col_expr(
            step::Column::Attempt,
            Expr::col(step::Column::Attempt).add(1),
        );
    }
    if w.bump_failures {
        q = q.col_expr(
            step::Column::Failures,
            Expr::col(step::Column::Failures).add(1),
        );
    }
    q = q.col_expr(step::Column::UpdatedAt, Expr::value(clock_now()));
    let res = q.exec(conn).await?;
    if res.rows_affected == 0 {
        return Ok(None);
    }
    get_step(conn, id).await
}

/// Add a step to a plan.
pub async fn insert_step<C: ConnectionTrait>(
    conn: &C,
    plan_id: i32,
    s: NewStep,
) -> Result<step::Model, DbError> {
    Ok(step_active(plan_id, s, clock_now()).insert(conn).await?)
}

/// Take a step out of a plan, when it is in one of `from`. Whether it was.
pub async fn delete_step<C: ConnectionTrait>(
    conn: &C,
    id: i32,
    from: &[StepState],
) -> Result<bool, DbError> {
    let res = step::Entity::delete_many()
        .filter(step::Column::Id.eq(id))
        .filter(step::Column::State.is_in(from.iter().copied()))
        .exec(conn)
        .await?;
    Ok(res.rows_affected > 0)
}

/// Move every step of a plan in one of `from` to `to`. How many moved.
pub async fn move_steps(
    conn: &DatabaseConnection,
    plan_id: i32,
    from: &[StepState],
    to: StepState,
) -> Result<u64, DbError> {
    let res = step::Entity::update_many()
        .filter(step::Column::PlanId.eq(plan_id))
        .filter(step::Column::State.is_in(from.iter().copied()))
        .col_expr(step::Column::State, Expr::value(to))
        .col_expr(step::Column::UpdatedAt, Expr::value(clock_now()))
        .exec(conn)
        .await?;
    Ok(res.rows_affected)
}
