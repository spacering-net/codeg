//! Routines (6.9): each assistant's own, and every run of each.
//!
//! Only the owning assistant's engine runs its routines, on its clock. A
//! scheduled run is claimed by moving the routine's next time on from the
//! one it was due at, in the same transaction that records the run, so one
//! time runs once; an event's run is one per routine and event by a unique
//! key. Undoing or deleting one keeps its row (`deleted_at`), so undo can
//! bring it back; an assistant deleted takes its routines with it.

use chrono::{DateTime, Utc};
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait,
    ActiveValue::{NotSet, Set},
    ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
    TransactionTrait,
};

use super::personal_agent_service::{colliding_entry, is_unique_violation, LedgerSlot, Ledgered};
use crate::db::entities::personal_agent_action::{self as action, ActionState};
use crate::db::entities::personal_agent_dispatch as dispatch;
use crate::db::entities::personal_agent_event as event;
use crate::db::entities::personal_agent_notice::{self as notice, NoticeKind};
use crate::db::entities::personal_agent_routine::{self as routine, RoutineKind, RoutineTrigger};
use crate::db::entities::personal_agent_routine_run::{self as run, RunOutcome};
use crate::db::entities::personal_agent_signal as signal;
use crate::db::entities::personal_agent_timeline::{self as timeline, TimelineKind};
use crate::db::error::DbError;

/// Now, as the assistants see it (a debug build's end-to-end run moves it).
fn clock_now() -> DateTime<Utc> {
    crate::personal_agent::clock::now()
}

/// A routine to make.
#[derive(Debug, Clone)]
pub struct NewRoutine {
    pub bot_id: i32,
    pub title: String,
    pub what: String,
    pub kind: RoutineKind,
    pub trigger: RoutineTrigger,
    pub cron: Option<String>,
    pub timezone: Option<String>,
    pub zone_used: Option<String>,
    pub event_kind: Option<String>,
    pub event_filter: Option<String>,
    pub dispatch: Option<String>,
    pub precheck: Option<String>,
    pub source: String,
    pub next_run_at: Option<DateTime<Utc>>,
    pub signal_cursor: i32,
    pub trial_pending: bool,
}

fn active(new: NewRoutine, now: DateTime<Utc>) -> routine::ActiveModel {
    routine::ActiveModel {
        id: NotSet,
        bot_id: Set(new.bot_id),
        title: Set(new.title),
        what: Set(new.what),
        kind: Set(new.kind),
        trigger: Set(new.trigger),
        cron: Set(new.cron),
        timezone: Set(new.timezone),
        zone_used: Set(new.zone_used),
        event_kind: Set(new.event_kind),
        event_filter: Set(new.event_filter),
        dispatch: Set(new.dispatch),
        precheck: Set(new.precheck),
        precheck_state: Set(None),
        enabled: Set(true),
        paused_reason: Set(None),
        source: Set(new.source),
        next_run_at: Set(new.next_run_at),
        last_run_at: Set(None),
        runs: Set(0),
        failures: Set(0),
        signal_cursor: Set(new.signal_cursor),
        trial_pending: Set(new.trial_pending),
        deleted_at: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
    }
}

pub async fn create(conn: &DatabaseConnection, new: NewRoutine) -> Result<routine::Model, DbError> {
    Ok(active(new, Utc::now()).insert(conn).await?)
}

/// Make a routine together with its ledger entry, in one transaction: a
/// re-delivered turn's same call finds the entry and makes nothing.
pub async fn create_ledgered(
    conn: &DatabaseConnection,
    new: NewRoutine,
    slot: &LedgerSlot,
    payload: Option<serde_json::Value>,
) -> Result<Ledgered<routine::Model>, DbError> {
    let bot = new.bot_id;
    let now = Utc::now();
    let txn = conn.begin().await?;
    let made = active(new, now).insert(&txn).await?;
    let entry = action::ActiveModel {
        id: NotSet,
        bot_id: Set(Some(bot)),
        batch_id: Set(slot.batch_id),
        key: Set(slot.key.clone()),
        kind: Set("routine".into()),
        state: Set(ActionState::Committed),
        ref_id: Set(Some(made.id.to_string())),
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
    .insert(&txn)
    .await;
    match entry {
        Ok(_) => {}
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
    txn.commit().await?;
    Ok(Ledgered::New(made))
}

/// A routine, deleted or not.
pub async fn get(conn: &DatabaseConnection, id: i32) -> Result<Option<routine::Model>, DbError> {
    Ok(routine::Entity::find_by_id(id).one(conn).await?)
}

/// One of `bot`'s routines that is not deleted.
pub async fn get_of(
    conn: &DatabaseConnection,
    bot: i32,
    id: i32,
) -> Result<Option<routine::Model>, DbError> {
    Ok(routine::Entity::find_by_id(id)
        .filter(routine::Column::BotId.eq(bot))
        .filter(routine::Column::DeletedAt.is_null())
        .one(conn)
        .await?)
}

/// `bot`'s routines, oldest first.
pub async fn list_of(conn: &DatabaseConnection, bot: i32) -> Result<Vec<routine::Model>, DbError> {
    Ok(routine::Entity::find()
        .filter(routine::Column::BotId.eq(bot))
        .filter(routine::Column::DeletedAt.is_null())
        .order_by_asc(routine::Column::Id)
        .all(conn)
        .await?)
}

/// Every assistant's routines.
pub async fn list_all(conn: &DatabaseConnection) -> Result<Vec<routine::Model>, DbError> {
    Ok(routine::Entity::find()
        .filter(routine::Column::DeletedAt.is_null())
        .order_by_asc(routine::Column::Id)
        .all(conn)
        .await?)
}

/// `bot`'s scheduled routines on, due by `now`.
pub async fn due(
    conn: &DatabaseConnection,
    bot: i32,
    now: DateTime<Utc>,
) -> Result<Vec<routine::Model>, DbError> {
    Ok(routine::Entity::find()
        .filter(routine::Column::BotId.eq(bot))
        .filter(routine::Column::DeletedAt.is_null())
        .filter(routine::Column::Enabled.eq(true))
        .filter(routine::Column::Trigger.eq(RoutineTrigger::Schedule))
        .filter(routine::Column::NextRunAt.lte(now))
        .order_by_asc(routine::Column::NextRunAt)
        .limit(50)
        .all(conn)
        .await?)
}

/// `bot`'s routines that are on.
pub async fn enabled_of(
    conn: &DatabaseConnection,
    bot: i32,
) -> Result<Vec<routine::Model>, DbError> {
    Ok(routine::Entity::find()
        .filter(routine::Column::BotId.eq(bot))
        .filter(routine::Column::DeletedAt.is_null())
        .filter(routine::Column::Enabled.eq(true))
        .order_by_asc(routine::Column::Id)
        .all(conn)
        .await?)
}

/// What to change of a routine; `None` leaves it.
#[derive(Debug, Clone, Default)]
pub struct RoutineWrite {
    pub title: Option<String>,
    pub what: Option<String>,
    pub kind: Option<RoutineKind>,
    pub trigger: Option<RoutineTrigger>,
    pub cron: Option<Option<String>>,
    pub timezone: Option<Option<String>>,
    pub zone_used: Option<Option<String>>,
    pub event_kind: Option<Option<String>>,
    pub event_filter: Option<Option<String>>,
    pub dispatch: Option<Option<String>>,
    pub precheck: Option<Option<String>>,
    pub precheck_state: Option<Option<String>>,
    pub enabled: Option<bool>,
    pub paused_reason: Option<Option<String>>,
    pub next_run_at: Option<Option<DateTime<Utc>>>,
    pub last_run_at: Option<Option<DateTime<Utc>>>,
    pub failures: Option<i32>,
    pub signal_cursor: Option<i32>,
    pub trial_pending: Option<bool>,
    pub deleted_at: Option<Option<DateTime<Utc>>>,
}

/// Change a routine. With `seen_next`, only while its next time is still
/// that one (the clock moved it meanwhile: nothing changes). `None` when
/// nothing matched.
pub async fn update(
    conn: &DatabaseConnection,
    id: i32,
    seen_next: Option<Option<DateTime<Utc>>>,
    w: RoutineWrite,
) -> Result<Option<routine::Model>, DbError> {
    let mut q = routine::Entity::update_many()
        .col_expr(routine::Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(routine::Column::Id.eq(id));
    match seen_next {
        Some(Some(t)) => q = q.filter(routine::Column::NextRunAt.eq(t)),
        Some(None) => q = q.filter(routine::Column::NextRunAt.is_null()),
        None => {}
    }
    macro_rules! set {
        ($field:ident, $col:ident) => {
            if let Some(v) = w.$field {
                q = q.col_expr(routine::Column::$col, Expr::value(v));
            }
        };
    }
    set!(title, Title);
    set!(what, What);
    if let Some(k) = w.kind {
        q = q.col_expr(routine::Column::Kind, Expr::value(k));
    }
    if let Some(t) = w.trigger {
        q = q.col_expr(routine::Column::Trigger, Expr::value(t));
    }
    set!(cron, Cron);
    set!(timezone, Timezone);
    set!(zone_used, ZoneUsed);
    set!(event_kind, EventKind);
    set!(event_filter, EventFilter);
    set!(dispatch, Dispatch);
    set!(precheck, Precheck);
    set!(precheck_state, PrecheckState);
    set!(enabled, Enabled);
    set!(paused_reason, PausedReason);
    set!(next_run_at, NextRunAt);
    set!(last_run_at, LastRunAt);
    set!(failures, Failures);
    set!(signal_cursor, SignalCursor);
    set!(trial_pending, TrialPending);
    set!(deleted_at, DeletedAt);
    let res = q.exec(conn).await?;
    if res.rows_affected == 0 {
        return Ok(None);
    }
    get(conn, id).await
}

/// One more run that ran: its number.
pub async fn count_run(conn: &DatabaseConnection, id: i32) -> Result<i32, DbError> {
    routine::Entity::update_many()
        .col_expr(
            routine::Column::Runs,
            Expr::col(routine::Column::Runs).add(1),
        )
        .filter(routine::Column::Id.eq(id))
        .exec(conn)
        .await?;
    Ok(get(conn, id).await?.map(|r| r.runs).unwrap_or(1))
}

/// A run to record.
#[derive(Debug, Clone)]
pub struct NewRun {
    pub routine_id: i32,
    pub bot_id: i32,
    pub trigger: String,
    pub event_key: Option<String>,
    pub due_at: Option<DateTime<Utc>>,
    pub outcome: RunOutcome,
    pub note: Option<String>,
}

fn run_active(new: NewRun, now: DateTime<Utc>) -> run::ActiveModel {
    let ended = !matches!(new.outcome, RunOutcome::Running | RunOutcome::Asked);
    run::ActiveModel {
        id: NotSet,
        routine_id: Set(new.routine_id),
        bot_id: Set(new.bot_id),
        seq: Set(0),
        trigger: Set(new.trigger),
        event_key: Set(new.event_key),
        due_at: Set(new.due_at),
        started_at: Set(now),
        ended_at: Set(ended.then_some(now)),
        outcome: Set(new.outcome),
        note: Set(new.note),
        batch_id: Set(None),
        event_id: Set(None),
        dispatch_id: Set(None),
        notice_id: Set(None),
        created_at: Set(now),
    }
}

/// Record a run. `None`: this routine ran for this event already.
pub async fn insert_run(
    conn: &DatabaseConnection,
    new: NewRun,
) -> Result<Option<run::Model>, DbError> {
    match run_active(new, clock_now()).insert(conn).await {
        Ok(m) => Ok(Some(m)),
        Err(e) if is_unique_violation(&e) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// A scheduled time came: move the routine's next time on from the one it
/// was due at (`seen_next`) and record the run, in one transaction. `None`
/// when it moved meanwhile — the time ran already.
pub async fn claim_due(
    conn: &DatabaseConnection,
    routine_id: i32,
    seen_next: DateTime<Utc>,
    next: Option<DateTime<Utc>>,
    zone_used: Option<String>,
    new: NewRun,
) -> Result<Option<run::Model>, DbError> {
    let now = clock_now();
    let txn = conn.begin().await?;
    let moved = routine::Entity::update_many()
        .col_expr(routine::Column::NextRunAt, Expr::value(next))
        .col_expr(routine::Column::ZoneUsed, Expr::value(zone_used))
        .col_expr(routine::Column::LastRunAt, Expr::value(now))
        .col_expr(routine::Column::UpdatedAt, Expr::value(now))
        .filter(routine::Column::Id.eq(routine_id))
        .filter(routine::Column::NextRunAt.eq(seen_next))
        .exec(&txn)
        .await?;
    if moved.rows_affected != 1 {
        txn.rollback().await?;
        return Ok(None);
    }
    let made = run_active(new, now).insert(&txn).await?;
    txn.commit().await?;
    Ok(Some(made))
}

/// What to change of a run.
#[derive(Debug, Clone, Default)]
pub struct RunWrite {
    pub seq: Option<i32>,
    pub outcome: Option<RunOutcome>,
    pub note: Option<Option<String>>,
    pub ended_at: Option<Option<DateTime<Utc>>>,
    pub batch_id: Option<Option<i32>>,
    pub event_id: Option<Option<i32>>,
    pub dispatch_id: Option<Option<i32>>,
    pub notice_id: Option<Option<i32>>,
}

/// Change a run, while its outcome is one of `from` (any, without).
pub async fn update_run(
    conn: &DatabaseConnection,
    id: i32,
    from: Option<&[RunOutcome]>,
    w: RunWrite,
) -> Result<Option<run::Model>, DbError> {
    let mut q = run::Entity::update_many().filter(run::Column::Id.eq(id));
    if let Some(from) = from {
        q = q.filter(run::Column::Outcome.is_in(from.iter().copied()));
    }
    let mut any = false;
    macro_rules! set {
        ($field:ident, $col:ident) => {
            if let Some(v) = w.$field {
                q = q.col_expr(run::Column::$col, Expr::value(v));
                any = true;
            }
        };
    }
    set!(seq, Seq);
    if let Some(o) = w.outcome {
        q = q.col_expr(run::Column::Outcome, Expr::value(o));
        any = true;
    }
    set!(note, Note);
    set!(ended_at, EndedAt);
    set!(batch_id, BatchId);
    set!(event_id, EventId);
    set!(dispatch_id, DispatchId);
    set!(notice_id, NoticeId);
    if !any {
        return get_run(conn, id).await;
    }
    let res = q.exec(conn).await?;
    if res.rows_affected == 0 {
        return Ok(None);
    }
    get_run(conn, id).await
}

pub async fn get_run(conn: &DatabaseConnection, id: i32) -> Result<Option<run::Model>, DbError> {
    Ok(run::Entity::find_by_id(id).one(conn).await?)
}

/// A routine's latest runs, newest first.
pub async fn runs_of(
    conn: &DatabaseConnection,
    routine_id: i32,
    limit: u64,
) -> Result<Vec<run::Model>, DbError> {
    Ok(run::Entity::find()
        .filter(run::Column::RoutineId.eq(routine_id))
        .order_by_desc(run::Column::Id)
        .limit(limit)
        .all(conn)
        .await?)
}

/// The runs a routine has under way: its assistant on one, or the work it
/// handed out, or waiting on the owner's confirmation.
pub async fn open_runs_of(
    conn: &DatabaseConnection,
    routine_id: i32,
) -> Result<Vec<run::Model>, DbError> {
    Ok(run::Entity::find()
        .filter(run::Column::RoutineId.eq(routine_id))
        .filter(run::Column::Outcome.is_in([RunOutcome::Running, RunOutcome::Asked]))
        .all(conn)
        .await?)
}

/// The run that handed out this work.
pub async fn run_of_dispatch(
    conn: &DatabaseConnection,
    dispatch_id: i32,
) -> Result<Option<run::Model>, DbError> {
    Ok(run::Entity::find()
        .filter(run::Column::DispatchId.eq(dispatch_id))
        .order_by_desc(run::Column::Id)
        .one(conn)
        .await?)
}

/// The runs these events woke their assistant for.
pub async fn runs_of_events(
    conn: &DatabaseConnection,
    event_ids: &[i32],
) -> Result<Vec<run::Model>, DbError> {
    if event_ids.is_empty() {
        return Ok(Vec::new());
    }
    Ok(run::Entity::find()
        .filter(run::Column::EventId.is_in(event_ids.iter().copied()))
        .all(conn)
        .await?)
}

/// The run waiting on this card.
pub async fn run_of_notice(
    conn: &DatabaseConnection,
    notice_id: i32,
) -> Result<Option<run::Model>, DbError> {
    Ok(run::Entity::find()
        .filter(run::Column::NoticeId.eq(notice_id))
        .one(conn)
        .await?)
}

/// Whether work was handed out by one of this routine's runs — itself, or
/// in the turn one of them woke its assistant for (`batch`).
pub async fn made_by_routine(
    conn: &DatabaseConnection,
    routine_id: i32,
    dispatch_id: i32,
    batch: Option<i32>,
) -> Result<bool, DbError> {
    let mut cond = sea_orm::Condition::any().add(run::Column::DispatchId.eq(dispatch_id));
    if let Some(b) = batch {
        cond = cond.add(run::Column::BatchId.eq(b));
    }
    Ok(run::Entity::find()
        .filter(run::Column::RoutineId.eq(routine_id))
        .filter(cond)
        .one(conn)
        .await?
        .is_some())
}

/// Every assistant's runs started in `[from, to)`, newest first.
pub async fn runs_between(
    conn: &DatabaseConnection,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<Vec<run::Model>, DbError> {
    Ok(run::Entity::find()
        .filter(run::Column::StartedAt.gte(from))
        .filter(run::Column::StartedAt.lt(to))
        .order_by_desc(run::Column::Id)
        .limit(200)
        .all(conn)
        .await?)
}

/// Every assistant's runs under way.
pub async fn running_runs(conn: &DatabaseConnection) -> Result<Vec<run::Model>, DbError> {
    Ok(run::Entity::find()
        .filter(run::Column::Outcome.eq(RunOutcome::Running))
        .order_by_desc(run::Column::Id)
        .limit(100)
        .all(conn)
        .await?)
}

/// An assistant deleted: its routines and their runs go with it.
pub async fn delete_of_bot(conn: &DatabaseConnection, bot: i32) -> Result<u64, DbError> {
    run::Entity::delete_many()
        .filter(run::Column::BotId.eq(bot))
        .exec(conn)
        .await?;
    let res = routine::Entity::delete_many()
        .filter(routine::Column::BotId.eq(bot))
        .exec(conn)
        .await?;
    Ok(res.rows_affected)
}

/// An event by its stored key.
pub async fn event_by_key(
    conn: &DatabaseConnection,
    key: &str,
) -> Result<Option<event::Model>, DbError> {
    Ok(event::Entity::find()
        .filter(event::Column::SourceKey.eq(key))
        .one(conn)
        .await?)
}

/// The events of `kind` a batch carried (and still holds: one put back to
/// wait has left it).
pub async fn events_of_batch(
    conn: &DatabaseConnection,
    batch_id: i32,
    kind: &str,
) -> Result<Vec<event::Model>, DbError> {
    Ok(event::Entity::find()
        .filter(event::Column::BatchId.eq(batch_id))
        .filter(event::Column::Kind.eq(kind))
        .all(conn)
        .await?)
}

/// The latest coding event's id (0: none yet).
pub async fn signal_head(conn: &DatabaseConnection) -> Result<i32, DbError> {
    Ok(signal::Entity::find()
        .order_by_desc(signal::Column::Id)
        .one(conn)
        .await?
        .map(|s| s.id)
        .unwrap_or(0))
}

/// The work `bot` handed out since `since`, newest first.
pub async fn dispatches_since(
    conn: &DatabaseConnection,
    bot: i32,
    since: DateTime<Utc>,
) -> Result<Vec<dispatch::Model>, DbError> {
    Ok(dispatch::Entity::find()
        .filter(dispatch::Column::BotId.eq(bot))
        .filter(dispatch::Column::CreatedAt.gte(since))
        .order_by_desc(dispatch::Column::Id)
        .limit(300)
        .all(conn)
        .await?)
}

/// The owner's messages to `bot` since `since`, newest first.
pub async fn owner_messages_since(
    conn: &DatabaseConnection,
    bot: i32,
    since: DateTime<Utc>,
    limit: u64,
) -> Result<Vec<timeline::Model>, DbError> {
    Ok(timeline::Entity::find()
        .filter(timeline::Column::BotId.eq(bot))
        .filter(timeline::Column::Kind.eq(TimelineKind::Owner))
        .filter(timeline::Column::CreatedAt.gte(since))
        .order_by_desc(timeline::Column::Id)
        .limit(limit)
        .all(conn)
        .await?)
}

/// `bot`'s cards of `kind` raised since `since`.
pub async fn notices_of_kind_since(
    conn: &DatabaseConnection,
    bot: i32,
    kind: NoticeKind,
    since: DateTime<Utc>,
) -> Result<Vec<notice::Model>, DbError> {
    Ok(notice::Entity::find()
        .filter(notice::Column::BotId.eq(bot))
        .filter(notice::Column::Kind.eq(kind))
        .filter(notice::Column::CreatedAt.gte(since))
        .all(conn)
        .await?)
}

/// The routine whose run handed out each of these dispatches.
pub async fn routines_of_dispatches(
    conn: &DatabaseConnection,
    dispatch_ids: &[i32],
) -> Result<std::collections::HashMap<i32, i32>, DbError> {
    if dispatch_ids.is_empty() {
        return Ok(Default::default());
    }
    Ok(run::Entity::find()
        .filter(run::Column::DispatchId.is_in(dispatch_ids.iter().copied()))
        .all(conn)
        .await?
        .into_iter()
        .filter_map(|r| r.dispatch_id.map(|d| (d, r.routine_id)))
        .collect())
}
