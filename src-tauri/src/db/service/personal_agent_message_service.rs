//! Storage of the messages assistants send each other, and of the threads
//! they form (4.8, 4.9).
//!
//! A message is written in one transaction with everything it sets going:
//! the receiver's event (what wakes it), the line on each side's timeline,
//! the sender's "waiting for an answer" matter, the thread's count — and,
//! for a call made in a delivery, its ledger entry, so a re-delivered turn
//! never sends it twice. An answer closes what it answers in the same
//! transaction. Inserts come first, as everywhere in the assistant's
//! storage (see `personal_agent_service`).

use std::collections::BTreeMap;

use chrono::Utc;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ColumnTrait, Condition, DatabaseConnection, EntityTrait,
    QueryFilter, QueryOrder, Set, TransactionTrait,
};

use super::personal_agent_service::{is_unique_violation, LedgerSlot, Ledgered, NewRow};
use crate::db::entities::personal_agent::{self as agent, BotKind};
use crate::db::entities::personal_agent_action::{self as action, ActionState};
use crate::db::entities::personal_agent_event::{self as event, EventState};
use crate::db::entities::personal_agent_item::{self as item, ItemKind, ItemStatus, WaitsFor};
use crate::db::entities::personal_agent_message::{self as message, MessageState};
use crate::db::entities::personal_agent_thread::{self as thread, ThreadState};
use crate::db::entities::personal_agent_timeline::{self as timeline, TimelineKind};
use crate::db::error::DbError;

/// The event kind a message reaches its receiver as.
pub const MESSAGE_EVENT: &str = "bot_message";

/// The states in which a message is still owed something: handed over (or
/// about to be) and not answered or closed.
pub const LIVE_MESSAGE_STATES: &[MessageState] = &[MessageState::Queued, MessageState::Delivered];

/// The key a pair of assistants is counted under on a thread: the same
/// whichever of them speaks.
pub fn pair_key(a: i32, b: i32) -> String {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    format!("{lo}-{hi}")
}

/// A thread's counts, by pair.
pub fn thread_counts(t: &thread::Model) -> BTreeMap<String, u32> {
    serde_json::from_str(&t.counts).unwrap_or_default()
}

/// The source key of the event a message reaches `to` as, before the
/// worker prefix (`personal_agent_service::scoped_source_key`).
fn event_key(message_id: i32) -> String {
    format!("message:{message_id}")
}

/// A message's event key as stored for receiver `to`.
async fn stored_event_key(
    conn: &impl sea_orm::ConnectionTrait,
    to: i32,
    message_id: i32,
) -> Result<String, DbError> {
    let primary = agent::Entity::find_by_id(to)
        .one(conn)
        .await?
        .is_none_or(|b| b.kind == BotKind::Primary);
    let key = event_key(message_id);
    Ok(if primary {
        key
    } else {
        format!("bot{to}:{key}")
    })
}

/// The thread a message goes on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThreadPick {
    /// One already open.
    On(i32),
    /// A new one, which the message starts (its id is the message's).
    New,
}

/// A message to write.
#[derive(Debug, Clone)]
pub struct NewMessage {
    pub from: i32,
    pub to: i32,
    pub body: String,
    pub wants_reply: bool,
    /// The message it answers: answered by it, and the waiting matter of
    /// its sender closed.
    pub reply_to: Option<i32>,
    pub thread: ThreadPick,
    pub origin_bot_id: Option<i32>,
    pub origin_row_id: Option<i32>,
    pub for_input: Option<String>,
    /// The sender's delivery it is sent from.
    pub sent_batch_id: Option<i32>,
    /// The sender's segment, for its line.
    pub sent_segment_id: Option<i32>,
    /// The receiver's event summary.
    pub summary: String,
    /// The sender's waiting matter (when an answer is wanted).
    pub waiting_summary: String,
    /// What each side's line carries besides the message's own fields
    /// (names, avatars), as the page draws it.
    pub sender_line: serde_json::Value,
    pub receiver_line: serde_json::Value,
    /// For a call made in a delivery: where its ledger entry goes.
    pub ledger: Option<LedgerSlot>,
    /// The card whose answer sends it: its ledger entry names it, so a
    /// restart settles the card as the entry stands.
    pub ledger_notice: Option<i32>,
    pub ledger_payload: Option<serde_json::Value>,
}

/// What sending a message wrote.
#[derive(Debug, Clone)]
pub struct Sent {
    pub message: message::Model,
    pub thread: thread::Model,
    pub sender_row: timeline::Model,
    pub receiver_row: timeline::Model,
    pub item: Option<item::Model>,
    /// The message it answered, and the receiver's waiting matter for it
    /// that it closed.
    pub answered: Option<message::Model>,
    pub closed_item: Option<i32>,
}

fn with(mut data: serde_json::Value, extra: serde_json::Value) -> serde_json::Value {
    if let (Some(map), Some(more)) = (data.as_object_mut(), extra.as_object()) {
        for (k, v) in more {
            map.insert(k.clone(), v.clone());
        }
    }
    data
}

/// Send a message: everything it sets going, in one transaction. A call
/// whose ledger slot is taken (the same call in a batch it re-delivers)
/// writes nothing and hands that entry back.
pub async fn send_message(
    conn: &DatabaseConnection,
    new: NewMessage,
) -> Result<Ledgered<Sent>, DbError> {
    if new.from <= 0 || new.to <= 0 {
        return Err(DbError::Conflict("a message needs both assistants".into()));
    }
    let now = Utc::now();
    let txn = conn.begin().await?;
    let inserted = message::ActiveModel {
        id: NotSet,
        thread_id: Set(match new.thread {
            ThreadPick::On(t) => Some(t),
            ThreadPick::New => None,
        }),
        from_bot_id: Set(new.from),
        to_bot_id: Set(new.to),
        reply_to: Set(new.reply_to),
        body: Set(new.body.clone()),
        wants_reply: Set(new.wants_reply),
        state: Set(MessageState::Queued),
        sent_batch_id: Set(new.sent_batch_id),
        delivered_batch_id: Set(None),
        origin_bot_id: Set(new.origin_bot_id),
        origin_row_id: Set(new.origin_row_id),
        for_input: Set(new.for_input.clone()),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(&txn)
    .await?;
    if let Some(slot) = new.ledger.as_ref() {
        let entry = action::ActiveModel {
            id: NotSet,
            bot_id: Set(Some(new.from)),
            batch_id: Set(slot.batch_id),
            key: Set(slot.key.clone()),
            kind: Set("message".into()),
            state: Set(ActionState::Committed),
            ref_id: Set(Some(inserted.id.to_string())),
            created_at: Set(now),
            updated_at: Set(now),
            op_id: Set(Some(slot.op_id.clone())),
            payload: Set(new.ledger_payload.as_ref().map(|p| p.to_string())),
            observed: Set(None),
            target: Set(None),
            notice_id: Set(new.ledger_notice),
            attempted_at: Set(None),
            detail: Set(None),
        }
        .insert(&txn)
        .await;
        match entry {
            Ok(_) => {}
            Err(e) if is_unique_violation(&e) => {
                txn.rollback().await?;
                let earlier = action::Entity::find()
                    .filter(
                        Condition::any()
                            .add(action::Column::OpId.eq(slot.op_id.clone()))
                            .add(
                                Condition::all()
                                    .add(action::Column::BatchId.eq(slot.batch_id))
                                    .add(action::Column::Key.eq(slot.key.clone())),
                            ),
                    )
                    .one(conn)
                    .await?
                    .ok_or_else(|| DbError::NotFound("ledger entry".into()))?;
                return Ok(Ledgered::Earlier(Box::new(earlier)));
            }
            Err(e) => {
                let _ = txn.rollback().await;
                return Err(e.into());
            }
        }
    }
    let pair = pair_key(new.from, new.to);
    let (thread_id, thread_row) = match new.thread {
        ThreadPick::New => {
            message::Entity::update_many()
                .col_expr(message::Column::ThreadId, Expr::value(inserted.id))
                .filter(message::Column::Id.eq(inserted.id))
                .exec(&txn)
                .await?;
            let mut counts = BTreeMap::new();
            counts.insert(pair.clone(), 1u32);
            let t = thread::ActiveModel {
                id: Set(inserted.id),
                state: Set(ThreadState::Open),
                counts: Set(serde_json::to_string(&counts).unwrap_or_else(|_| "{}".into())),
                last_progress_at: Set(None),
                origin_bot_id: Set(new.origin_bot_id),
                origin_row_id: Set(new.origin_row_id),
                created_at: Set(now),
                updated_at: Set(now),
            }
            .insert(&txn)
            .await?;
            (inserted.id, t)
        }
        ThreadPick::On(t) => {
            let current = thread::Entity::find_by_id(t)
                .one(&txn)
                .await?
                .ok_or_else(|| DbError::NotFound(format!("thread {t}")))?;
            let mut counts = thread_counts(&current);
            *counts.entry(pair.clone()).or_insert(0) += 1;
            let counts = serde_json::to_string(&counts).unwrap_or_else(|_| "{}".into());
            thread::Entity::update_many()
                .col_expr(thread::Column::Counts, Expr::value(counts.clone()))
                .col_expr(thread::Column::UpdatedAt, Expr::value(now))
                .filter(thread::Column::Id.eq(t))
                .exec(&txn)
                .await?;
            (
                t,
                thread::Model {
                    counts,
                    updated_at: now,
                    ..current
                },
            )
        }
    };
    let message = message::Model {
        thread_id: Some(thread_id),
        ..inserted
    };
    let key = stored_event_key(&txn, new.to, message.id).await?;
    let ev = event::ActiveModel {
        id: NotSet,
        kind: Set(MESSAGE_EVENT.into()),
        source_key: Set(key),
        coalesce_key: Set(None),
        summary: Set(new.summary.clone()),
        payload: Set(Some(
            serde_json::json!({ "message_id": message.id, "from": new.from }).to_string(),
        )),
        wake: Set(true),
        state: Set(EventState::Pending),
        batch_id: Set(None),
        requeues: Set(0),
        requeued_from: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
        bot_id: Set(Some(new.to)),
        origin_bot_id: Set(new.origin_bot_id),
        origin_row_id: Set(new.origin_row_id),
        thread_id: Set(Some(thread_id)),
    }
    .insert(&txn)
    .await?;
    let common = serde_json::json!({
        "message_id": message.id,
        "thread_id": thread_id,
        "from_bot_id": new.from,
        "to_bot_id": new.to,
        "reply_to": new.reply_to,
        "wants_reply": new.wants_reply,
        "state": "queued",
    });
    let mut out_row = NewRow::new(TimelineKind::Exchange, new.body.clone());
    out_row.batch_id = new.sent_batch_id;
    out_row.segment_id = new.sent_segment_id;
    out_row.ref_id = Some(format!("m{}", message.id));
    out_row.data = Some(with(
        with(common.clone(), serde_json::json!({ "direction": "out" })),
        new.sender_line.clone(),
    ));
    let sender_row = out_row.into_active(new.from, now).insert(&txn).await?;
    let mut in_row = NewRow::new(TimelineKind::Exchange, new.body.clone());
    in_row.ref_id = Some(format!("m{}", message.id));
    in_row.event_id = Some(ev.id);
    in_row.data = Some(with(
        with(common, serde_json::json!({ "direction": "in" })),
        new.receiver_line.clone(),
    ));
    let receiver_row = in_row.into_active(new.to, now).insert(&txn).await?;
    let made_item = if new.wants_reply {
        Some(
            item::ActiveModel {
                id: NotSet,
                kind: Set(ItemKind::Message),
                dispatch_id: Set(None),
                status: Set(ItemStatus::Waiting),
                waits_for: Set(Some(WaitsFor::Agent)),
                summary: Set(new.waiting_summary.clone()),
                on_done: Set(None),
                origin_timeline_id: Set(Some(sender_row.id)),
                created_at: Set(now),
                updated_at: Set(now),
                bot_id: Set(Some(new.from)),
            }
            .insert(&txn)
            .await?,
        )
    } else {
        None
    };
    // An answer: what it answers is answered, and its sender — this
    // message's receiver — no longer waits for it.
    let mut answered = None;
    let mut closed_item = None;
    if let Some(orig) = new.reply_to {
        message::Entity::update_many()
            .col_expr(message::Column::State, Expr::value(MessageState::Replied))
            .col_expr(message::Column::UpdatedAt, Expr::value(now))
            .filter(message::Column::Id.eq(orig))
            .filter(message::Column::State.is_in(LIVE_MESSAGE_STATES.to_vec()))
            .exec(&txn)
            .await?;
        answered = message::Entity::find_by_id(orig).one(&txn).await?;
        let line = timeline::Entity::find()
            .filter(timeline::Column::BotId.eq(new.to))
            .filter(timeline::Column::Kind.eq(TimelineKind::Exchange))
            .filter(timeline::Column::RefId.eq(format!("m{orig}")))
            .one(&txn)
            .await?;
        if let Some(line) = line {
            let waiting = item::Entity::find()
                .filter(item::Column::BotId.eq(new.to))
                .filter(item::Column::Kind.eq(ItemKind::Message))
                .filter(item::Column::OriginTimelineId.eq(line.id))
                .filter(item::Column::Status.is_in([ItemStatus::Open, ItemStatus::Waiting]))
                .one(&txn)
                .await?;
            if let Some(w) = waiting {
                item::Entity::update_many()
                    .col_expr(item::Column::Status, Expr::value(ItemStatus::Done))
                    .col_expr(
                        item::Column::WaitsFor,
                        Expr::value(Option::<WaitsFor>::None),
                    )
                    .col_expr(item::Column::UpdatedAt, Expr::value(now))
                    .filter(item::Column::Id.eq(w.id))
                    .exec(&txn)
                    .await?;
                closed_item = Some(w.id);
            }
        }
    }
    txn.commit().await?;
    Ok(Ledgered::New(Sent {
        message,
        thread: thread_row,
        sender_row,
        receiver_row,
        item: made_item,
        answered,
        closed_item,
    }))
}

pub async fn get_message(
    conn: &DatabaseConnection,
    id: i32,
) -> Result<Option<message::Model>, DbError> {
    Ok(message::Entity::find_by_id(id).one(conn).await?)
}

pub async fn messages_by_ids(
    conn: &DatabaseConnection,
    ids: &[i32],
) -> Result<Vec<message::Model>, DbError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    Ok(message::Entity::find()
        .filter(message::Column::Id.is_in(ids.to_vec()))
        .order_by_asc(message::Column::Id)
        .all(conn)
        .await?)
}

pub async fn get_thread(
    conn: &DatabaseConnection,
    id: i32,
) -> Result<Option<thread::Model>, DbError> {
    Ok(thread::Entity::find_by_id(id).one(conn).await?)
}

/// Every message on a thread, oldest first.
pub async fn messages_of_thread(
    conn: &DatabaseConnection,
    thread_id: i32,
) -> Result<Vec<message::Model>, DbError> {
    Ok(message::Entity::find()
        .filter(message::Column::ThreadId.eq(thread_id))
        .order_by_asc(message::Column::Id)
        .all(conn)
        .await?)
}

/// Whether `bot` waits on `thread_id` for an answer: it sent a message
/// there that wants one and has none yet.
pub async fn waits_on_thread(
    conn: &DatabaseConnection,
    thread_id: i32,
    bot: i32,
) -> Result<bool, DbError> {
    Ok(message::Entity::find()
        .filter(message::Column::ThreadId.eq(thread_id))
        .filter(message::Column::FromBotId.eq(bot))
        .filter(message::Column::WantsReply.eq(true))
        .filter(message::Column::State.is_in(LIVE_MESSAGE_STATES.to_vec()))
        .one(conn)
        .await?
        .is_some())
}

/// The messages handed to a delivery: delivered, in that batch. Returns
/// those moved now.
pub async fn mark_messages_delivered(
    conn: &DatabaseConnection,
    ids: &[i32],
    batch_id: i32,
) -> Result<Vec<i32>, DbError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let queued: Vec<i32> = message::Entity::find()
        .filter(message::Column::Id.is_in(ids.to_vec()))
        .filter(message::Column::State.eq(MessageState::Queued))
        .all(conn)
        .await?
        .into_iter()
        .map(|m| m.id)
        .collect();
    if queued.is_empty() {
        return Ok(queued);
    }
    message::Entity::update_many()
        .col_expr(message::Column::State, Expr::value(MessageState::Delivered))
        .col_expr(message::Column::DeliveredBatchId, Expr::value(batch_id))
        .col_expr(message::Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(message::Column::Id.is_in(queued.clone()))
        .filter(message::Column::State.eq(MessageState::Queued))
        .exec(conn)
        .await?;
    Ok(queued)
}

/// Move messages in one of `from` to `to`. Returns the ids moved.
pub async fn move_messages(
    conn: &DatabaseConnection,
    ids: &[i32],
    from: &[MessageState],
    to: MessageState,
) -> Result<Vec<i32>, DbError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let moving: Vec<i32> = message::Entity::find()
        .filter(message::Column::Id.is_in(ids.to_vec()))
        .filter(message::Column::State.is_in(from.to_vec()))
        .all(conn)
        .await?
        .into_iter()
        .map(|m| m.id)
        .collect();
    if moving.is_empty() {
        return Ok(moving);
    }
    message::Entity::update_many()
        .col_expr(message::Column::State, Expr::value(to))
        .col_expr(message::Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(message::Column::Id.is_in(moving.clone()))
        .filter(message::Column::State.is_in(from.to_vec()))
        .exec(conn)
        .await?;
    Ok(moving)
}

/// Take a message back before its receiver started on it: its event is
/// settled unread while still waiting, and then the message is `to`
/// (stopped, canceled). False — nothing changed — when the receiver's
/// delivery took it first: it is being handled.
pub async fn withdraw_message(
    conn: &DatabaseConnection,
    m: &message::Model,
    to: MessageState,
) -> Result<bool, DbError> {
    let key = stored_event_key(conn, m.to_bot_id, m.id).await?;
    let now = Utc::now();
    let txn = conn.begin().await?;
    let taken = event::Entity::update_many()
        .col_expr(event::Column::State, Expr::value(EventState::Done))
        .col_expr(event::Column::UpdatedAt, Expr::value(now))
        .filter(event::Column::SourceKey.eq(key))
        .filter(event::Column::State.eq(EventState::Pending))
        // Never handed out: one put back by an interrupted turn was.
        .filter(event::Column::RequeuedFrom.is_null())
        .exec(&txn)
        .await?;
    if taken.rows_affected != 1 {
        txn.rollback().await?;
        return Ok(false);
    }
    let moved = message::Entity::update_many()
        .col_expr(message::Column::State, Expr::value(to))
        .col_expr(message::Column::UpdatedAt, Expr::value(now))
        .filter(message::Column::Id.eq(m.id))
        .filter(message::Column::State.eq(MessageState::Queued))
        .exec(&txn)
        .await?;
    if moved.rows_affected != 1 {
        txn.rollback().await?;
        return Ok(false);
    }
    txn.commit().await?;
    Ok(true)
}

/// Messages `bot` sent from batch `batch_id`.
pub async fn messages_sent_in(
    conn: &DatabaseConnection,
    bot: i32,
    batch_id: i32,
) -> Result<Vec<message::Model>, DbError> {
    Ok(message::Entity::find()
        .filter(message::Column::FromBotId.eq(bot))
        .filter(message::Column::SentBatchId.eq(batch_id))
        .order_by_asc(message::Column::Id)
        .all(conn)
        .await?)
}

/// Messages `bot` sent that are still owed something.
pub async fn live_messages_from(
    conn: &DatabaseConnection,
    bot: i32,
) -> Result<Vec<message::Model>, DbError> {
    Ok(message::Entity::find()
        .filter(message::Column::FromBotId.eq(bot))
        .filter(message::Column::State.is_in(LIVE_MESSAGE_STATES.to_vec()))
        .order_by_asc(message::Column::Id)
        .all(conn)
        .await?)
}

/// Messages `bot` sent for input `for_input`.
pub async fn messages_for_input(
    conn: &DatabaseConnection,
    bot: i32,
    for_input: &str,
) -> Result<Vec<message::Model>, DbError> {
    Ok(message::Entity::find()
        .filter(message::Column::FromBotId.eq(bot))
        .filter(message::Column::ForInput.eq(for_input))
        .order_by_asc(message::Column::Id)
        .all(conn)
        .await?)
}

/// Move a thread from one of `from` to `to`. False when it was in none.
pub async fn move_thread(
    conn: &DatabaseConnection,
    id: i32,
    from: &[ThreadState],
    to: ThreadState,
) -> Result<bool, DbError> {
    let res = thread::Entity::update_many()
        .col_expr(thread::Column::State, Expr::value(to))
        .col_expr(thread::Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(thread::Column::Id.eq(id))
        .filter(thread::Column::State.is_in(from.to_vec()))
        .exec(conn)
        .await?;
    Ok(res.rows_affected == 1)
}

/// Something moved on a thread: its counts start over.
pub async fn thread_progress(conn: &DatabaseConnection, id: i32) -> Result<(), DbError> {
    let now = Utc::now();
    thread::Entity::update_many()
        .col_expr(thread::Column::Counts, Expr::value("{}"))
        .col_expr(thread::Column::LastProgressAt, Expr::value(now))
        .col_expr(thread::Column::UpdatedAt, Expr::value(now))
        .filter(thread::Column::Id.eq(id))
        .exec(conn)
        .await?;
    Ok(())
}

/// The open threads `bot` is on (it sent or received a message there).
pub async fn open_threads_of(conn: &DatabaseConnection, bot: i32) -> Result<Vec<i32>, DbError> {
    let mut ids: Vec<i32> = message::Entity::find()
        .filter(
            Condition::any()
                .add(message::Column::FromBotId.eq(bot))
                .add(message::Column::ToBotId.eq(bot)),
        )
        .all(conn)
        .await?
        .into_iter()
        .filter_map(|m| m.thread_id)
        .collect();
    ids.sort_unstable();
    ids.dedup();
    if ids.is_empty() {
        return Ok(ids);
    }
    Ok(thread::Entity::find()
        .filter(thread::Column::Id.is_in(ids))
        .filter(thread::Column::State.eq(ThreadState::Open))
        .all(conn)
        .await?
        .into_iter()
        .map(|t| t.id)
        .collect())
}

/// The lines a message wrote on the timelines (one per side).
pub async fn lines_of_message(
    conn: &DatabaseConnection,
    message_id: i32,
) -> Result<Vec<timeline::Model>, DbError> {
    Ok(timeline::Entity::find()
        .filter(timeline::Column::Kind.eq(TimelineKind::Exchange))
        .filter(timeline::Column::RefId.eq(format!("m{message_id}")))
        .all(conn)
        .await?)
}

/// The sender's waiting matter of a message, by the sender's line.
pub async fn waiting_item_of_line(
    conn: &DatabaseConnection,
    bot: i32,
    line_id: i32,
) -> Result<Option<item::Model>, DbError> {
    Ok(item::Entity::find()
        .filter(item::Column::BotId.eq(bot))
        .filter(item::Column::Kind.eq(ItemKind::Message))
        .filter(item::Column::OriginTimelineId.eq(line_id))
        .one(conn)
        .await?)
}
