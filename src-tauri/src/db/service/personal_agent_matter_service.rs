//! Taking back what the owner did to one of an assistant's matters on the
//! panel (C1), and how an undo stands while it still can be.
//!
//! The owner's act (`personal_agent_service::update_item_with`) writes what
//! takes it back into the payload of the one line the assistant reads about
//! it, in the same transaction — the matter as it was, the matter as the
//! act left it, the reminder cards it closed, the message it took back —
//! and that line's id is the token. Taking it back is one transaction too:
//! the matter is put back only while it is still as the act left it (no
//! write since, no firing), so an undo never writes over something that
//! happened after; what the act set going elsewhere (a message taken back,
//! a question's answer) is checked as it stands now and put back as it
//! would have been.

use chrono::{DateTime, Utc};
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ColumnTrait, ConnectionTrait, DatabaseConnection,
    EntityTrait, QueryFilter, QueryOrder, Set, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::personal_agent_message_service::{stored_event_key, LIVE_MESSAGE_STATES};
use super::personal_agent_service::scoped_source_key;
use crate::db::entities::personal_agent as agent;
use crate::db::entities::personal_agent_batch::{self as batch, BatchStatus};
use crate::db::entities::personal_agent_event::{self as event, EventState};
use crate::db::entities::personal_agent_item::{self as item, ItemStatus, WaitsFor};
use crate::db::entities::personal_agent_message::{self as message, MessageState};
use crate::db::entities::personal_agent_notice::{self as notice, NoticeState};
use crate::db::entities::personal_agent_timeline::{self as timeline, OwnerStatus};
use crate::db::error::DbError;

/// How long the owner has to take an act back.
pub const UNDO_WINDOW_SECS: i64 = 600;

/// The event kind of the line an act on a matter writes (`reminders`).
const ITEM_NOTE: &str = "item_note";

/// The data key an owner row claimed for a turn in flight carries until
/// the turn took it (`merged`) or did not: the batch it was claimed for.
pub const STEER_CLAIM: &str = "steer_claim";
/// The data key of an owner row folded into a turn in flight.
pub const MERGED: &str = "merged";
/// The data key of an answer's row that keeps the time its question had
/// before the answer cleared it ([`AnswerPrior`]).
pub const ANSWER_PRIOR: &str = "answer_prior";

/// A question's time as it was when the owner's answer was linked to it
/// (which clears it: an answered question is not reminded of): put back
/// when the turn that had the answer does not finish, unless somebody set
/// the question's time themselves meanwhile — that took it off the
/// answer's row. Kept on the answer's row: a matter has no data column.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnswerPrior {
    pub due_at: Option<DateTime<Utc>>,
    pub repeat: Option<String>,
    pub at_due: Option<String>,
    pub act_spec: Option<String>,
    /// The owner's zone as the answer came, for the rule's next time.
    pub tz: String,
}

impl AnswerPrior {
    /// `item`'s time, if it has one.
    pub fn of(item: &item::Model, tz: chrono_tz::Tz) -> Option<Self> {
        item.due_at.map(|due_at| Self {
            due_at: Some(due_at),
            repeat: item.repeat.clone(),
            at_due: item.at_due.clone(),
            act_spec: item.act_spec.clone(),
            tz: tz.name().to_string(),
        })
    }

    /// Its time as it stands at `now`, and the rule with it: as it was,
    /// when it has not come yet (a repeating matter's first time, or a
    /// moment it was put off to); the rule's next time after `now`, when
    /// it went by and the rule goes on; none for a one-off whose time went
    /// by, nor for a rule that ended.
    pub fn due_again(&self, now: DateTime<Utc>) -> Option<(DateTime<Utc>, Option<String>)> {
        use crate::personal_agent::due::{next_after, Repeat};
        let due_at = self.due_at?;
        if due_at > now {
            return Some((due_at, self.repeat.clone()));
        }
        let rule = Repeat::parse(self.repeat.as_deref())?;
        let tz = crate::personal_agent::clock::zone_of(&self.tz);
        let next = next_after(&rule, tz, now)?;
        // The rule's own time now, not a moment of its own.
        let repeat = serde_json::to_string(&rule.placed(tz, false)).ok();
        Some((next, repeat))
    }
}

/// The time owner row `row` keeps for the question it answers, if any.
fn prior_on(row: &timeline::Model) -> Option<AnswerPrior> {
    serde_json::from_value(row_data(row).get(ANSWER_PRIOR)?.clone()).ok()
}

/// Write `prior` on owner row `row_id` (`None`: take it off), inside `txn`.
async fn write_prior(
    txn: &impl ConnectionTrait,
    row_id: i32,
    prior: Option<&AnswerPrior>,
) -> Result<(), DbError> {
    let Some(row) = timeline::Entity::find_by_id(row_id).one(txn).await? else {
        return Ok(());
    };
    let mut data = row_data(&row);
    let Some(map) = data.as_object_mut() else {
        return Ok(());
    };
    match prior {
        Some(p) => {
            map.insert(ANSWER_PRIOR.into(), serde_json::json!(p));
        }
        None if map.remove(ANSWER_PRIOR).is_some() => {}
        None => return Ok(()),
    }
    timeline::Entity::update_many()
        .col_expr(timeline::Column::Data, Expr::value(Some(data.to_string())))
        .filter(timeline::Column::Id.eq(row_id))
        .exec(txn)
        .await?;
    Ok(())
}

/// Take the time a question had before its answer off the answer's row
/// `row_id`, inside `txn`: somebody set the question's time themselves
/// while it waited on the answer, and that time stands. What it was.
pub async fn take_answer_prior(
    txn: &impl ConnectionTrait,
    row_id: i32,
) -> Result<Option<AnswerPrior>, DbError> {
    let prior = match timeline::Entity::find_by_id(row_id).one(txn).await? {
        Some(row) => prior_on(&row),
        None => None,
    };
    if prior.is_some() {
        write_prior(txn, row_id, None).await?;
    }
    Ok(prior)
}

/// Put question `item_id`'s time back as `prior` says at `now`, inside
/// `txn` ([`AnswerPrior::due_again`]); not fired for it — the time put
/// back is always still to come. Whether it had one to put back.
pub async fn restore_prior(
    txn: &impl ConnectionTrait,
    item_id: i32,
    prior: &AnswerPrior,
    now: DateTime<Utc>,
) -> Result<bool, DbError> {
    let Some((due_at, repeat)) = prior.due_again(now) else {
        return Ok(false);
    };
    item::Entity::update_many()
        .col_expr(item::Column::DueAt, Expr::value(Some(due_at)))
        .col_expr(item::Column::Repeat, Expr::value(repeat))
        .col_expr(item::Column::AtDue, Expr::value(prior.at_due.clone()))
        .col_expr(item::Column::ActSpec, Expr::value(prior.act_spec.clone()))
        .col_expr(item::Column::FiredAt, Expr::value(None::<DateTime<Utc>>))
        .col_expr(item::Column::UpdatedAt, Expr::value(now))
        .filter(item::Column::Id.eq(item_id))
        .exec(txn)
        .await?;
    Ok(true)
}

/// Why an act cannot be taken back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UndoRefused {
    /// No such act of the owner's on the panel (or not of this matter).
    None,
    /// More than [`UNDO_WINDOW_SECS`] ago.
    Expired,
    /// The matter came up (fired) since.
    Fired,
    /// It was written since.
    Changed,
    /// The message the act took back, or stopped waiting for, was
    /// answered.
    Replied { peer: i32 },
    /// The assistant that message went to was deleted.
    PeerGone { peer: i32 },
    /// The answer to the question was read by a turn that finished.
    AnswerRead,
}

/// What an undo wrote.
#[derive(Debug, Clone)]
pub struct Undone {
    pub item: item::Model,
    /// The reminder cards' rows opened again.
    pub rows: Vec<timeline::Model>,
    /// A message taken back and queued again: `(id, receiver)`.
    pub requeued: Option<(i32, i32)>,
}

#[derive(Debug, Clone, Deserialize)]
struct UndoNote {
    op: String,
    source: String,
    #[serde(default)]
    message: Option<NoteMessage>,
    before: Before,
    after: After,
    #[serde(default)]
    cards: Vec<CardSnap>,
    /// The time the question had before its answer, which this act took
    /// off the answer's row ([`take_answer_prior`]): the undo puts it
    /// back as the answer stands then.
    #[serde(default)]
    answer_prior: Option<AnswerPrior>,
}

#[derive(Debug, Clone, Deserialize)]
struct NoteMessage {
    id: i32,
    to_bot_id: i32,
    outcome: String,
}

#[derive(Debug, Clone, Deserialize)]
struct Before {
    status: ItemStatus,
    waits_for: Option<WaitsFor>,
    due_at: Option<DateTime<Utc>>,
    repeat: Option<String>,
    at_due: Option<String>,
    act_spec: Option<String>,
    fired_at: Option<DateTime<Utc>>,
    closed_at: Option<DateTime<Utc>>,
    closed_by: Option<String>,
    closed_how: Option<String>,
    answer_row_id: Option<i32>,
    answer_state: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct After {
    updated_at: DateTime<Utc>,
    status: ItemStatus,
    due_at: Option<DateTime<Utc>>,
    fired_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Deserialize)]
struct CardSnap {
    notice_id: i32,
    to_state: NoticeState,
    row_id: Option<i32>,
    #[serde(default)]
    row_before: Option<Value>,
}

/// The owner's act on the panel that line `token` records for `bot`'s
/// matter `item_id`.
async fn undo_note(
    conn: &impl ConnectionTrait,
    bot: i32,
    item_id: i32,
    token: i32,
) -> Result<Option<(event::Model, UndoNote)>, DbError> {
    let Some(ev) = event::Entity::find_by_id(token)
        .filter(event::Column::BotId.eq(bot))
        .filter(event::Column::Kind.eq(ITEM_NOTE))
        .one(conn)
        .await?
    else {
        return Ok(None);
    };
    Ok(note_of(&ev, item_id).map(|n| (ev, n)))
}

/// The panel's act `ev` records on matter `item_id`, if it is one.
fn note_of(ev: &event::Model, item_id: i32) -> Option<UndoNote> {
    let payload: Value = serde_json::from_str(ev.payload.as_deref()?).ok()?;
    if payload["item_id"].as_i64() != Some(i64::from(item_id)) {
        return None;
    }
    let note: UndoNote = serde_json::from_value(payload.get("undo")?.clone()).ok()?;
    (note.source == "panel").then_some(note)
}

/// How a question's answer stands as an undo puts the question back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnswerNow {
    /// Still to be settled: the question waits for it again.
    Linked,
    /// The turn that had it did not finish: the question is the owner's.
    Interrupted,
    /// A turn that finished read it.
    Read,
}

/// An owner row's data, as JSON.
pub fn row_data(row: &timeline::Model) -> Value {
    row.data
        .as_deref()
        .and_then(|d| serde_json::from_str::<Value>(d).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}))
}

/// Whether owner row `row` reached its turn for sure: delivered with it, or
/// folded into a turn in flight (`merged`). One claimed for a turn in
/// flight and not folded yet (`steer_claim` alone) is not.
pub fn confirmed(row: &timeline::Model) -> bool {
    let data = row_data(row);
    data.get(STEER_CLAIM).is_none_or(Value::is_null) || data[MERGED].as_bool() == Some(true)
}

/// How the answer in owner row `row_id` stands now (§4.3): what settling
/// it would have done to its question.
pub async fn answer_now(
    conn: &impl ConnectionTrait,
    row_id: Option<i32>,
) -> Result<AnswerNow, DbError> {
    let row = match row_id {
        Some(id) => timeline::Entity::find_by_id(id).one(conn).await?,
        None => None,
    };
    let status = match row.as_ref().and_then(|r| r.batch_id) {
        Some(b) => batch::Entity::find_by_id(b).one(conn).await?.map(|b| b.status),
        None => None,
    };
    Ok(answer_now_from(row.as_ref(), status))
}

/// [`answer_now`] of the answer's row `row` as read, its batch's status
/// `status`.
fn answer_now_from(row: Option<&timeline::Model>, status: Option<BatchStatus>) -> AnswerNow {
    let Some(row) = row else {
        return AnswerNow::Interrupted;
    };
    match row.status {
        Some(OwnerStatus::Queued) => AnswerNow::Linked,
        Some(OwnerStatus::Interrupted) | None => AnswerNow::Interrupted,
        Some(OwnerStatus::Delivered | OwnerStatus::Answered) if !confirmed(row) => {
            AnswerNow::Linked
        }
        // Delivered: its turn runs, or ended and the row was not moved
        // yet (a crash in between): settled as it ends, or at the start.
        Some(OwnerStatus::Delivered) => AnswerNow::Linked,
        Some(OwnerStatus::Answered) => match status {
            Some(BatchStatus::Completed) => AnswerNow::Read,
            Some(BatchStatus::Running) => AnswerNow::Linked,
            _ => AnswerNow::Interrupted,
        },
    }
}

/// Why the message an act took back (or stopped waiting for) keeps it
/// from being taken back now, if it does: its answer came, or its
/// receiver is gone.
async fn message_refusal(
    conn: &impl ConnectionTrait,
    m: &NoteMessage,
) -> Result<Option<UndoRefused>, DbError> {
    let peer = agent::Entity::find_by_id(m.to_bot_id).one(conn).await?;
    // A receiver may still answer a message taken back or stopped: the
    // answer is what matters, not the message's state.
    let replied = message::Entity::find()
        .filter(message::Column::ReplyTo.eq(m.id))
        .filter(message::Column::FromBotId.eq(m.to_bot_id))
        .one(conn)
        .await?
        .is_some();
    let msg = message::Entity::find_by_id(m.id).one(conn).await?;
    Ok(message_refusal_from(m, peer.as_ref(), replied, msg.as_ref()))
}

/// [`message_refusal`] from what it reads: the receiver (`peer`), whether
/// it answered the message (`replied`), and the message itself.
fn message_refusal_from(
    m: &NoteMessage,
    peer: Option<&agent::Model>,
    replied: bool,
    msg: Option<&message::Model>,
) -> Option<UndoRefused> {
    let to = m.to_bot_id;
    if peer.is_none_or(|b| b.deleted_at.is_some()) {
        return Some(UndoRefused::PeerGone { peer: to });
    }
    if replied {
        return Some(UndoRefused::Replied { peer: to });
    }
    let Some(msg) = msg else {
        return Some(UndoRefused::Changed);
    };
    let ok = match m.outcome.as_str() {
        "withdrawn" => msg.state == MessageState::Stopped,
        _ => LIVE_MESSAGE_STATES.contains(&msg.state),
    };
    match (ok, msg.state) {
        (true, _) => None,
        (false, MessageState::Replied) => Some(UndoRefused::Replied { peer: to }),
        (false, _) => Some(UndoRefused::Changed),
    }
}

/// Why the answer the act closed (or dropped) a question on keeps it from
/// being taken back, if it does.
async fn answer_refusal(
    conn: &impl ConnectionTrait,
    before: &Before,
) -> Result<(Option<UndoRefused>, Option<AnswerNow>), DbError> {
    if before.answer_state.as_deref() != Some("linked") {
        return Ok((None, None));
    }
    let now = answer_now(conn, before.answer_row_id).await?;
    Ok(answer_refusal_from(now))
}

/// [`answer_refusal`] of a linked answer standing `now`.
fn answer_refusal_from(now: AnswerNow) -> (Option<UndoRefused>, Option<AnswerNow>) {
    match now {
        AnswerNow::Read => (Some(UndoRefused::AnswerRead), Some(now)),
        _ => (None, Some(now)),
    }
}

/// Take back the owner's act `token` on `bot`'s matter `item_id` (§4.3),
/// in one transaction: the matter as it was — only if it is still as the
/// act left it — its reminder cards open again, a message it took back
/// queued again, and the line the assistant reads about it settled unread
/// if it was never handed out (else a line that it was taken back).
pub async fn undo_item_op(
    conn: &DatabaseConnection,
    bot: i32,
    item_id: i32,
    token: i32,
    now: DateTime<Utc>,
) -> Result<Result<Undone, UndoRefused>, DbError> {
    let Some((ev, note)) = undo_note(conn, bot, item_id, token).await? else {
        return Ok(Err(UndoRefused::None));
    };
    if (now - ev.created_at).num_seconds() > UNDO_WINDOW_SECS {
        return Ok(Err(UndoRefused::Expired));
    }
    let undo_key = scoped_source_key(
        conn,
        bot,
        &format!(
            "item_undo:{item_id}:{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ),
    )
    .await?;
    let b = &note.before;
    let at = Utc::now();
    let txn = conn.begin().await?;
    // Written first: the transaction holds the write lock from here on, so
    // nothing read below changes before it commits.
    let mut put = item::Entity::update_many()
        .col_expr(item::Column::Status, Expr::value(b.status))
        .col_expr(item::Column::WaitsFor, Expr::value(b.waits_for))
        .col_expr(item::Column::DueAt, Expr::value(b.due_at))
        .col_expr(item::Column::Repeat, Expr::value(b.repeat.clone()))
        .col_expr(item::Column::AtDue, Expr::value(b.at_due.clone()))
        .col_expr(item::Column::ActSpec, Expr::value(b.act_spec.clone()))
        .col_expr(item::Column::FiredAt, Expr::value(b.fired_at))
        .col_expr(item::Column::ClosedAt, Expr::value(b.closed_at))
        .col_expr(item::Column::ClosedBy, Expr::value(b.closed_by.clone()))
        .col_expr(item::Column::ClosedHow, Expr::value(b.closed_how.clone()))
        .col_expr(item::Column::AnswerRowId, Expr::value(b.answer_row_id))
        .col_expr(item::Column::AnswerState, Expr::value(b.answer_state.clone()))
        .col_expr(item::Column::UpdatedAt, Expr::value(at))
        .filter(item::Column::Id.eq(item_id))
        .filter(item::Column::BotId.eq(bot))
        .filter(item::Column::UpdatedAt.eq(note.after.updated_at))
        .filter(item::Column::Status.eq(note.after.status));
    put = match note.after.due_at {
        Some(d) => put.filter(item::Column::DueAt.eq(d)),
        None => put.filter(item::Column::DueAt.is_null()),
    };
    put = match note.after.fired_at {
        Some(f) => put.filter(item::Column::FiredAt.eq(f)),
        None => put.filter(item::Column::FiredAt.is_null()),
    };
    if put.exec(&txn).await?.rows_affected != 1 {
        txn.rollback().await?;
        let fired = item::Entity::find_by_id(item_id)
            .one(conn)
            .await?
            .is_some_and(|i| i.fired_at != note.after.fired_at);
        return Ok(Err(if fired {
            UndoRefused::Fired
        } else {
            UndoRefused::Changed
        }));
    }
    // A question the owner had answered: back as its answer stands now.
    let (refused, answer) = answer_refusal(&txn, b).await?;
    if let Some(why) = refused {
        txn.rollback().await?;
        return Ok(Err(why));
    }
    // The time the question had before its answer: this act took it off
    // the answer's row (or it is still there, the act having set no time).
    let prior = match (&note.answer_prior, b.answer_row_id) {
        (Some(p), _) => Some(p.clone()),
        (None, Some(row_id)) => timeline::Entity::find_by_id(row_id)
            .one(&txn)
            .await?
            .as_ref()
            .and_then(prior_on),
        (None, None) => None,
    };
    if answer == Some(AnswerNow::Interrupted) {
        item::Entity::update_many()
            .col_expr(item::Column::WaitsFor, Expr::value(Some(WaitsFor::Owner)))
            .col_expr(item::Column::Status, Expr::value(ItemStatus::Waiting))
            .col_expr(item::Column::AnswerState, Expr::value(Some("interrupted".to_string())))
            .filter(item::Column::Id.eq(item_id))
            .exec(&txn)
            .await?;
        // Its answer's turn did not finish: its time back, as one does.
        if let Some(p) = &prior {
            restore_prior(&txn, item_id, p, at).await?;
        }
    } else if answer == Some(AnswerNow::Linked) {
        // Waiting on the answer again: the time goes back on its row, to
        // come back should that turn not finish.
        if let (Some(p), Some(row_id)) = (&note.answer_prior, b.answer_row_id) {
            write_prior(&txn, row_id, Some(p)).await?;
        }
    }
    let mut requeued = None;
    if let Some(m) = &note.message {
        if let Some(why) = message_refusal(&txn, m).await? {
            txn.rollback().await?;
            return Ok(Err(why));
        }
        if m.outcome == "withdrawn" {
            let back = message::Entity::update_many()
                .col_expr(message::Column::State, Expr::value(MessageState::Queued))
                .col_expr(message::Column::UpdatedAt, Expr::value(at))
                .filter(message::Column::Id.eq(m.id))
                .filter(message::Column::State.eq(MessageState::Stopped))
                .exec(&txn)
                .await?;
            let key = stored_event_key(&txn, m.to_bot_id, m.id).await?;
            let again = event::Entity::update_many()
                .col_expr(event::Column::State, Expr::value(EventState::Pending))
                .col_expr(event::Column::UpdatedAt, Expr::value(at))
                .filter(event::Column::SourceKey.eq(key))
                .filter(event::Column::State.eq(EventState::Done))
                .filter(event::Column::RequeuedFrom.is_null())
                .filter(event::Column::BatchId.is_null())
                .exec(&txn)
                .await?;
            if back.rows_affected != 1 || again.rows_affected != 1 {
                txn.rollback().await?;
                return Ok(Err(UndoRefused::Changed));
            }
            requeued = Some((m.id, m.to_bot_id));
        }
    }
    let mut rows = Vec::new();
    for c in &note.cards {
        let opened = notice::Entity::update_many()
            .col_expr(notice::Column::State, Expr::value(NoticeState::Open))
            .col_expr(notice::Column::ActedAt, Expr::value(None::<DateTime<Utc>>))
            .col_expr(notice::Column::UpdatedAt, Expr::value(at))
            .filter(notice::Column::Id.eq(c.notice_id))
            .filter(notice::Column::State.eq(c.to_state))
            .exec(&txn)
            .await?;
        if opened.rows_affected != 1 {
            continue;
        }
        let (Some(row_id), Some(was)) = (c.row_id, c.row_before.as_ref()) else {
            continue;
        };
        let Some(row) = timeline::Entity::find_by_id(row_id).one(&txn).await? else {
            continue;
        };
        let mut data = row_data(&row);
        for k in ["state", "until", "error", "error_key", "error_params"] {
            data[k] = was.get(k).cloned().unwrap_or(Value::Null);
        }
        timeline::Entity::update_many()
            .col_expr(timeline::Column::Data, Expr::value(Some(data.to_string())))
            .col_expr(timeline::Column::UpdatedAt, Expr::value(at))
            .filter(timeline::Column::Id.eq(row_id))
            .exec(&txn)
            .await?;
        if let Some(r) = timeline::Entity::find_by_id(row_id).one(&txn).await? {
            rows.push(r);
        }
    }
    // Never handed out (an event an interrupted turn put back was): the
    // assistant reads neither the act nor its undo.
    let unread = event::Entity::update_many()
        .col_expr(event::Column::State, Expr::value(EventState::Done))
        .col_expr(event::Column::UpdatedAt, Expr::value(at))
        .filter(event::Column::Id.eq(ev.id))
        .filter(event::Column::State.eq(EventState::Pending))
        .filter(event::Column::BatchId.is_null())
        .filter(event::Column::RequeuedFrom.is_null())
        .filter(event::Column::Requeues.eq(0))
        .exec(&txn)
        .await?;
    let Some(item) = item::Entity::find_by_id(item_id).one(&txn).await? else {
        txn.rollback().await?;
        return Ok(Err(UndoRefused::Changed));
    };
    if unread.rows_affected != 1 {
        let what = match note.op.as_str() {
            "done" => "marking it done",
            "skip" => "skipping it",
            "drop" => "dropping it",
            "snooze" => "putting it off",
            _ => "setting it aside",
        };
        let summary: String = item.summary.chars().take(120).collect();
        event::ActiveModel {
            id: NotSet,
            kind: Set(ITEM_NOTE.into()),
            source_key: Set(undo_key),
            coalesce_key: Set(None),
            summary: Set(format!(
                "The owner took back {what} for #{item_id} \"{summary}\": it is as it was before."
            )),
            payload: Set(Some(serde_json::json!({ "item_id": item_id }).to_string())),
            wake: Set(false),
            state: Set(EventState::Pending),
            batch_id: Set(None),
            requeues: Set(0),
            requeued_from: Set(None),
            created_at: Set(at),
            updated_at: Set(at),
            bot_id: Set(Some(bot)),
            origin_bot_id: Set(None),
            origin_row_id: Set(None),
            thread_id: Set(None),
        }
        .insert(&txn)
        .await?;
    }
    txn.commit().await?;
    Ok(Ok(Undone {
        item,
        rows,
        requeued,
    }))
}

/// [`item_undo_token`] of each of `items`, by the matter's id — in a fixed
/// number of reads, however many there are ("done today" lists them all):
/// the window's panel lines of their assistants, read once and the latest
/// of each matter kept; then, for those that could be taken back, the
/// messages they took back and the receivers, the replies, the answers'
/// rows and their batches, each read once for all. Judged as one at a time
/// would be.
pub async fn item_undo_tokens(
    conn: &DatabaseConnection,
    items: &[item::Model],
    now: DateTime<Utc>,
) -> Result<std::collections::HashMap<i32, i32>, DbError> {
    use std::collections::{HashMap, HashSet};
    let mut out = HashMap::new();
    let bots: HashSet<i32> = items.iter().filter_map(|i| i.bot_id).collect();
    if bots.is_empty() {
        return Ok(out);
    }
    let since = now - chrono::Duration::seconds(UNDO_WINDOW_SECS);
    let notes = event::Entity::find()
        .filter(event::Column::BotId.is_in(bots.iter().copied().collect::<Vec<_>>()))
        .filter(event::Column::Kind.eq(ITEM_NOTE))
        .filter(event::Column::CreatedAt.gte(since))
        .order_by_desc(event::Column::Id)
        .all(conn)
        .await?;
    // Each matter's latest line, whatever it is: an older act is not the
    // one taken back.
    let mut latest: HashMap<(i32, i32), &event::Model> = HashMap::new();
    for ev in &notes {
        let Some(bot) = ev.bot_id else {
            continue;
        };
        let item_id = ev
            .payload
            .as_deref()
            .and_then(|p| serde_json::from_str::<Value>(p).ok())
            .and_then(|p| p["item_id"].as_i64())
            .and_then(|id| i32::try_from(id).ok());
        if let Some(item_id) = item_id {
            latest.entry((bot, item_id)).or_insert(ev);
        }
    }
    // The acts that could be taken back, as far as the matter goes.
    let mut open: Vec<(&item::Model, &event::Model, UndoNote)> = Vec::new();
    for i in items {
        let Some(bot) = i.bot_id else {
            continue;
        };
        let Some(ev) = latest.get(&(bot, i.id)) else {
            continue;
        };
        let Some(note) = note_of(ev, i.id) else {
            continue;
        };
        if note.after.updated_at != i.updated_at || note.after.status != i.status {
            continue;
        }
        open.push((i, ev, note));
    }
    if open.is_empty() {
        return Ok(out);
    }
    // What their checks read, once for all (a few hundred ids a query, well
    // under SQLite's bound on a statement's variables).
    const CHUNK: usize = 500;
    let messages: Vec<&NoteMessage> = open.iter().filter_map(|(_, _, n)| n.message.as_ref()).collect();
    let to_bots: Vec<i32> = messages
        .iter()
        .map(|m| m.to_bot_id)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let mut peers: HashMap<i32, agent::Model> = HashMap::new();
    for ids in to_bots.chunks(CHUNK) {
        for b in agent::Entity::find()
            .filter(agent::Column::Id.is_in(ids.to_vec()))
            .all(conn)
            .await?
        {
            peers.insert(b.id, b);
        }
    }
    let message_ids: Vec<i32> = messages.iter().map(|m| m.id).collect();
    let mut sent: HashMap<i32, message::Model> = HashMap::new();
    let mut replies: Vec<message::Model> = Vec::new();
    for ids in message_ids.chunks(CHUNK) {
        for m in message::Entity::find()
            .filter(message::Column::Id.is_in(ids.to_vec()))
            .all(conn)
            .await?
        {
            sent.insert(m.id, m);
        }
        replies.extend(
            message::Entity::find()
                .filter(message::Column::ReplyTo.is_in(ids.to_vec()))
                .all(conn)
                .await?,
        );
    }
    let answer_rows: Vec<i32> = open
        .iter()
        .filter(|(_, _, n)| n.before.answer_state.as_deref() == Some("linked"))
        .filter_map(|(_, _, n)| n.before.answer_row_id)
        .collect();
    let mut rows: HashMap<i32, timeline::Model> = HashMap::new();
    for ids in answer_rows.chunks(CHUNK) {
        for r in timeline::Entity::find()
            .filter(timeline::Column::Id.is_in(ids.to_vec()))
            .all(conn)
            .await?
        {
            rows.insert(r.id, r);
        }
    }
    let batch_ids: Vec<i32> = rows
        .values()
        .filter_map(|r| r.batch_id)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let mut batches: HashMap<i32, BatchStatus> = HashMap::new();
    for ids in batch_ids.chunks(CHUNK) {
        for b in batch::Entity::find()
            .filter(batch::Column::Id.is_in(ids.to_vec()))
            .all(conn)
            .await?
        {
            batches.insert(b.id, b.status);
        }
    }
    for (i, ev, note) in open {
        if let Some(m) = &note.message {
            let replied = replies
                .iter()
                .any(|r| r.reply_to == Some(m.id) && r.from_bot_id == m.to_bot_id);
            if message_refusal_from(m, peers.get(&m.to_bot_id), replied, sent.get(&m.id)).is_some() {
                continue;
            }
        }
        if note.before.answer_state.as_deref() == Some("linked") {
            let row = note.before.answer_row_id.and_then(|id| rows.get(&id));
            let status = row.and_then(|r| r.batch_id).and_then(|b| batches.get(&b).copied());
            if answer_refusal_from(answer_now_from(row, status)).0.is_some() {
                continue;
            }
        }
        out.insert(i.id, ev.id);
    }
    Ok(out)
}

/// What takes back the owner's latest act on `item` from the panel, while
/// it still would (§4.6, "done today"'s [Undo]): within the window, the
/// matter not written since, and nothing it set going in the way — the
/// same checks `undo_item_op` makes. One at a time; "done today" reads
/// them all at once ([`item_undo_tokens`]).
#[cfg(test)]
pub async fn item_undo_token(
    conn: &DatabaseConnection,
    item: &item::Model,
    now: DateTime<Utc>,
) -> Result<Option<i32>, DbError> {
    let Some(bot) = item.bot_id else {
        return Ok(None);
    };
    let since = now - chrono::Duration::seconds(UNDO_WINDOW_SECS);
    let notes = event::Entity::find()
        .filter(event::Column::BotId.eq(bot))
        .filter(event::Column::Kind.eq(ITEM_NOTE))
        .filter(event::Column::CreatedAt.gte(since))
        .order_by_desc(event::Column::Id)
        .all(conn)
        .await?;
    let latest = notes.iter().find(|ev| {
        ev.payload
            .as_deref()
            .and_then(|p| serde_json::from_str::<Value>(p).ok())
            .is_some_and(|p| p["item_id"].as_i64() == Some(i64::from(item.id)))
    });
    let Some(ev) = latest else {
        return Ok(None);
    };
    let Some(note) = note_of(ev, item.id) else {
        return Ok(None);
    };
    if note.after.updated_at != item.updated_at || note.after.status != item.status {
        return Ok(None);
    }
    if let Some(m) = &note.message {
        if message_refusal(conn, m).await?.is_some() {
            return Ok(None);
        }
    }
    if answer_refusal(conn, &note.before).await?.0.is_some() {
        return Ok(None);
    }
    Ok(Some(ev.id))
}

// ── a question's answer (§5) ────────────────────────────────────────────────

/// The data key of an owner row that answers one of the assistant's
/// questions: `{ id, summary, linked_at }`.
pub const ANSWERS_ITEM: &str = "answers_item";

/// The question owner row `row` answers, if it does.
pub fn answers_item_of(row: &timeline::Model) -> Option<i32> {
    row_data(row)[ANSWERS_ITEM]["id"]
        .as_i64()
        .and_then(|v| i32::try_from(v).ok())
}

/// Take the write lock first: SQLite upgrades a reading transaction to a
/// writing one only if nobody wrote meanwhile, so a transaction that reads
/// before it writes writes first.
async fn write_first(txn: &sea_orm::DatabaseTransaction) -> Result<(), DbError> {
    txn.execute_unprepared("UPDATE personal_agent_item SET id = id WHERE 0")
        .await?;
    Ok(())
}

/// What an owner row's move does to the question it answers (§5.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnswerMove {
    /// Its turn finished: the assistant has read it — the question closes.
    Close,
    /// Its turn did not finish: back to the owner.
    Revert,
    /// Neither yet.
    Keep,
}

/// The question `item_id`, still waiting on the answer in `row_id`: the
/// condition every settling of an answer is made on, so a question the
/// assistant or the owner moved meanwhile (which clears its answer) is
/// left as they made it.
fn linked_to(
    update: sea_orm::UpdateMany<item::Entity>,
    item_id: i32,
    row_id: i32,
) -> sea_orm::UpdateMany<item::Entity> {
    update
        .filter(item::Column::Id.eq(item_id))
        .filter(waiting_on_its_answer())
        .filter(item::Column::AnswerRowId.eq(row_id))
}

/// A question waiting on the assistant to read the owner's answer linked
/// to it — [`linked_to`] short of which question and which answer.
fn waiting_on_its_answer() -> sea_orm::Condition {
    sea_orm::Condition::all()
        .add(item::Column::Status.eq(ItemStatus::Waiting))
        .add(item::Column::WaitsFor.eq(WaitsFor::Agent))
        .add(item::Column::AnswerState.eq("linked"))
}

/// Of `pairs` — a question, and the owner row that answers it — those its
/// settling would still take ([`linked_to`]): what a delivery tells the
/// assistant its turn's end will do with the question is what it does,
/// as things stand when the delivery is put together. A question the
/// assistant or the owner moved meanwhile, or answered again in a later
/// row, is not among them.
pub async fn still_linked(
    conn: &impl ConnectionTrait,
    pairs: &[(i32, i32)],
) -> Result<std::collections::HashSet<(i32, i32)>, DbError> {
    if pairs.is_empty() {
        return Ok(Default::default());
    }
    let ids: Vec<i32> = pairs.iter().map(|(item, _)| *item).collect();
    let waiting = item::Entity::find()
        .filter(item::Column::Id.is_in(ids))
        .filter(waiting_on_its_answer())
        .all(conn)
        .await?;
    Ok(pairs
        .iter()
        .copied()
        .filter(|(item_id, row_id)| {
            waiting
                .iter()
                .any(|i| i.id == *item_id && i.answer_row_id == Some(*row_id))
        })
        .collect())
}

/// Settle the question owner row `row_id` answers as `how` says, inside
/// `txn`. Whether it changed.
async fn settle_answer(
    txn: &sea_orm::DatabaseTransaction,
    item_id: i32,
    row_id: i32,
    how: AnswerMove,
) -> Result<bool, DbError> {
    use super::personal_agent_service::{closing_exprs, Closer, Closing};
    let now = Utc::now();
    let update = match how {
        AnswerMove::Keep => return Ok(false),
        AnswerMove::Close => closing_exprs(
            item::Entity::update_many(),
            ItemStatus::Done,
            Some(Closing::new(Closer::Codeg, "answered")),
            now,
        )
        .col_expr(item::Column::Status, Expr::value(ItemStatus::Done))
        .col_expr(item::Column::WaitsFor, Expr::value(None::<WaitsFor>))
        // The answer's row stays: "done today" goes to it.
        .col_expr(item::Column::AnswerState, Expr::value(None::<String>)),
        AnswerMove::Revert => item::Entity::update_many()
            .col_expr(item::Column::WaitsFor, Expr::value(Some(WaitsFor::Owner)))
            .col_expr(
                item::Column::AnswerState,
                Expr::value(Some("interrupted".to_string())),
            ),
    }
    .col_expr(item::Column::UpdatedAt, Expr::value(now));
    let settled = linked_to(update, item_id, row_id)
        .exec(txn)
        .await?
        .rows_affected
        == 1;
    if settled {
        match how {
            // Answered: the time it had before is done with.
            AnswerMove::Close => {
                take_answer_prior(txn, row_id).await?;
            }
            // Back with the owner: its time back, as it would stand now.
            AnswerMove::Revert => {
                if let Some(prior) = timeline::Entity::find_by_id(row_id)
                    .one(txn)
                    .await?
                    .as_ref()
                    .and_then(prior_on)
                {
                    restore_prior(txn, item_id, &prior, now).await?;
                }
            }
            AnswerMove::Keep => {}
        }
    }
    Ok(settled)
}

/// What moving owner rows did: the rows as they are now, and the questions
/// their answers settled.
#[derive(Debug, Clone, Default)]
pub struct RowsMoved {
    pub rows: Vec<timeline::Model>,
    pub items: Vec<i32>,
}

/// [`super::personal_agent_service::move_owner_rows`], in one transaction
/// with what the move does to the questions the rows answer: of the rows
/// this move did move, those that reached their turn for sure
/// ([`confirmed`]) settle their question as `answers` says; one claimed for
/// a turn in flight and not folded yet is left to how that comes out
/// ([`settle_steer`]).
///
/// `settling_batch`, when set, is the batch whose end this is: a row
/// another batch has — delivered with it, claimed for it, folded into it —
/// is not this one's to move, nor its question this one's to settle, even
/// when this turn once counted it among its own.
#[allow(clippy::too_many_arguments)]
pub async fn move_owner_rows_settling(
    conn: &DatabaseConnection,
    ids: &[i32],
    from: &[OwnerStatus],
    to: OwnerStatus,
    batch_id: Option<i32>,
    segment_id: Option<i32>,
    read: super::personal_agent_service::ReadMark,
    answers: AnswerMove,
    settling_batch: Option<i32>,
) -> Result<RowsMoved, DbError> {
    use super::personal_agent_service::move_owner_rows;
    if ids.is_empty() {
        return Ok(RowsMoved::default());
    }
    let txn = conn.begin().await?;
    write_first(&txn).await?;
    let moving: Vec<timeline::Model> = timeline::Entity::find()
        .filter(timeline::Column::Id.is_in(ids.to_vec()))
        .filter(timeline::Column::Kind.eq(timeline::TimelineKind::Owner))
        .filter(timeline::Column::Status.is_in(from.to_vec()))
        .all(&txn)
        .await?
        .into_iter()
        .filter(|r| settling_batch.is_none_or(|b| of_batch(r, b)))
        .collect();
    // The write lock is held from the first statement: what was read is
    // what moves.
    let ids: Vec<i32> = moving.iter().map(|r| r.id).collect();
    let rows = move_owner_rows(&txn, &ids, from, to, batch_id, segment_id, read).await?;
    let mut items = Vec::new();
    for r in moving.iter().filter(|r| confirmed(r)) {
        if let Some(item_id) = answers_item_of(r) {
            if settle_answer(&txn, item_id, r.id, answers).await? {
                items.push(item_id);
            }
        }
    }
    txn.commit().await?;
    Ok(RowsMoved { rows, items })
}

/// Whether owner row `r` is batch `b`'s: delivered with it, and not
/// claimed for another's turn.
fn of_batch(r: &timeline::Model, b: i32) -> bool {
    let claim = &row_data(r)[STEER_CLAIM];
    r.batch_id == Some(b) && (claim.is_null() || claim.as_i64() == Some(i64::from(b)))
}

/// Claim owner row `row_id` for the turn in flight (`batch_id`), before it
/// is folded into it, in one write: delivered with that batch, read, and
/// marked as claimed (`steer_claim`) — not yet known to have reached it.
pub async fn claim_owner_row_for_steering(
    conn: &DatabaseConnection,
    row_id: i32,
    batch_id: i32,
    segment_id: i32,
) -> Result<bool, DbError> {
    let now = Utc::now();
    let res = timeline::Entity::update_many()
        .col_expr(timeline::Column::Status, Expr::value(OwnerStatus::Delivered))
        .col_expr(timeline::Column::BatchId, Expr::value(batch_id))
        .col_expr(timeline::Column::SegmentId, Expr::value(segment_id))
        .col_expr(timeline::Column::ReadAt, Expr::value(Some(now)))
        .col_expr(timeline::Column::UpdatedAt, Expr::value(now))
        .col_expr(
            timeline::Column::Data,
            Expr::cust_with_values(
                "json_set(CASE WHEN json_valid(data) THEN data ELSE '{}' END, '$.steer_claim', ?)",
                [sea_orm::Value::from(batch_id)],
            ),
        )
        .filter(timeline::Column::Id.eq(row_id))
        .filter(timeline::Column::Kind.eq(timeline::TimelineKind::Owner))
        .filter(timeline::Column::Status.eq(OwnerStatus::Queued))
        .exec(conn)
        .await?;
    Ok(res.rows_affected == 1)
}

/// How a hand-over of owner row `row_id` to the turn in flight came out
/// (`folded`), in one transaction: folded, it is the turn's for sure
/// (`merged`) — and settles its question as its turn did if that ended
/// meanwhile; not folded, it goes back in the queue unread (from "answered"
/// too, when the turn ended meanwhile: nothing of it reached the agent) —
/// unless an interruption left it "interrupted", to be sent again, when
/// its question goes back to the owner. The row and the questions settled.
/// Only while the row is still claimed for `batch_id`: a hand-over that
/// comes out after another batch took the row is not this one's.
pub async fn settle_steer(
    conn: &DatabaseConnection,
    row_id: i32,
    batch_id: i32,
    folded: bool,
) -> Result<RowsMoved, DbError> {
    let txn = conn.begin().await?;
    write_first(&txn).await?;
    let Some(row) = timeline::Entity::find_by_id(row_id)
        .one(&txn)
        .await?
        .filter(|r| row_data(r)[STEER_CLAIM].as_i64() == Some(i64::from(batch_id)))
    else {
        txn.rollback().await?;
        return Ok(RowsMoved::default());
    };
    let now = Utc::now();
    let mut data = row_data(&row);
    if let Some(map) = data.as_object_mut() {
        map.remove(STEER_CLAIM);
        if folded {
            map.insert(MERGED.into(), true.into());
        }
    }
    let batch_status = match row.batch_id {
        Some(b) => batch::Entity::find_by_id(b).one(&txn).await?.map(|b| b.status),
        None => None,
    };
    let mut update = timeline::Entity::update_many()
        .col_expr(timeline::Column::Data, Expr::value(Some(data.to_string())))
        .col_expr(timeline::Column::UpdatedAt, Expr::value(now))
        .filter(timeline::Column::Id.eq(row_id));
    let how = if folded {
        match batch_status {
            Some(BatchStatus::Running) | None => AnswerMove::Keep,
            Some(BatchStatus::Completed) => AnswerMove::Close,
            Some(_) => AnswerMove::Revert,
        }
    } else if row.status == Some(OwnerStatus::Interrupted) {
        AnswerMove::Revert
    } else {
        if matches!(row.status, Some(OwnerStatus::Delivered | OwnerStatus::Answered)) {
            update = update
                .col_expr(timeline::Column::Status, Expr::value(OwnerStatus::Queued))
                .col_expr(
                    timeline::Column::ReadAt,
                    Expr::value(None::<DateTime<Utc>>),
                );
        }
        AnswerMove::Keep
    };
    update.exec(&txn).await?;
    let mut items = Vec::new();
    if let Some(item_id) = answers_item_of(&row) {
        if settle_answer(&txn, item_id, row_id, how).await? {
            items.push(item_id);
        }
    }
    let rows = timeline::Entity::find_by_id(row_id)
        .one(&txn)
        .await?
        .into_iter()
        .collect();
    txn.commit().await?;
    Ok(RowsMoved { rows, items })
}

/// Owner rows of `bot` a crash left between their turn's end and their own
/// settling, and the questions they answer (§5.3, at the start): a row
/// still "delivered" — or claimed for a turn and never folded — whose
/// turn is over is settled as that turn would have; a question still
/// waiting on an answer whose row was interrupted goes back to the owner.
/// Chosen by the rows alone, whatever their questions are now; running it
/// again changes nothing.
pub async fn settle_stranded_owner_rows(
    conn: &DatabaseConnection,
    bot: i32,
) -> Result<RowsMoved, DbError> {
    use super::personal_agent_service::ReadMark;
    let mut out = RowsMoved::default();
    let rows = timeline::Entity::find()
        .filter(timeline::Column::BotId.eq(bot))
        .filter(timeline::Column::Kind.eq(timeline::TimelineKind::Owner))
        .filter(
            sea_orm::Condition::any()
                .add(timeline::Column::Status.eq(OwnerStatus::Delivered))
                .add(
                    sea_orm::Condition::all()
                        .add(timeline::Column::Status.eq(OwnerStatus::Answered))
                        .add(Expr::cust(
                            "json_valid(data) AND json_extract(data, '$.steer_claim') IS NOT NULL",
                        )),
                ),
        )
        .order_by_asc(timeline::Column::Id)
        .all(conn)
        .await?;
    for r in rows {
        let Some(b) = r.batch_id else {
            continue;
        };
        let Some(status) = batch::Entity::find_by_id(b).one(conn).await?.map(|b| b.status)
        else {
            continue;
        };
        let sure = confirmed(&r);
        let (to, how) = match (status, sure) {
            (BatchStatus::Running, _) => continue,
            (BatchStatus::Completed, true) => (OwnerStatus::Answered, AnswerMove::Close),
            (BatchStatus::Canceled, true) => (OwnerStatus::Answered, AnswerMove::Revert),
            (BatchStatus::Interrupted, true) => (OwnerStatus::Interrupted, AnswerMove::Revert),
            (BatchStatus::Failed, _) => (OwnerStatus::Queued, AnswerMove::Keep),
            (_, false) => (OwnerStatus::Interrupted, AnswerMove::Revert),
        };
        let txn = conn.begin().await?;
        write_first(&txn).await?;
        let mut data = row_data(&r);
        if !sure {
            if let Some(map) = data.as_object_mut() {
                map.remove(STEER_CLAIM);
            }
        }
        let mut update = timeline::Entity::update_many()
            .col_expr(timeline::Column::Status, Expr::value(to))
            .col_expr(timeline::Column::Data, Expr::value(Some(data.to_string())))
            .col_expr(timeline::Column::UpdatedAt, Expr::value(Utc::now()))
            .filter(timeline::Column::Id.eq(r.id))
            .filter(timeline::Column::Status.eq(r.status));
        if matches!(read_mark(to), ReadMark::Unread) {
            update = update.col_expr(timeline::Column::ReadAt, Expr::value(None::<DateTime<Utc>>));
        }
        if update.exec(&txn).await?.rows_affected != 1 {
            txn.rollback().await?;
            continue;
        }
        if let Some(item_id) = answers_item_of(&r) {
            // Settled as the turn would have — or, not known to have
            // reached it, as interrupted.
            let how = if sure { how } else { AnswerMove::Revert };
            let how = if to == OwnerStatus::Queued { AnswerMove::Keep } else { how };
            if settle_answer(&txn, item_id, r.id, how).await? {
                out.items.push(item_id);
            }
        }
        txn.commit().await?;
        if let Some(m) = timeline::Entity::find_by_id(r.id).one(conn).await? {
            out.rows.push(m);
        }
    }
    // Questions still waiting on an answer whose row was interrupted.
    let linked = item::Entity::find()
        .filter(item::Column::BotId.eq(bot))
        .filter(item::Column::AnswerState.eq("linked"))
        .filter(item::Column::AnswerRowId.is_not_null())
        .all(conn)
        .await?;
    for i in linked {
        let Some(row_id) = i.answer_row_id else {
            continue;
        };
        let interrupted = timeline::Entity::find_by_id(row_id)
            .one(conn)
            .await?
            .is_none_or(|r| r.status == Some(OwnerStatus::Interrupted));
        if !interrupted {
            continue;
        }
        let txn = conn.begin().await?;
        if settle_answer(&txn, i.id, row_id, AnswerMove::Revert).await? {
            out.items.push(i.id);
        }
        txn.commit().await?;
    }
    Ok(out)
}

/// How a move to `to` marks an owner row read.
fn read_mark(to: OwnerStatus) -> super::personal_agent_service::ReadMark {
    use super::personal_agent_service::ReadMark;
    match to {
        OwnerStatus::Queued => ReadMark::Unread,
        _ => ReadMark::Keep,
    }
}

/// What linking an answer to a question wrote.
#[derive(Debug, Clone)]
pub struct Answering {
    pub row: timeline::Model,
    /// The question, waiting on its answer now.
    pub item: item::Model,
    /// Its reminder cards' rows, closed.
    pub cards: Vec<timeline::Model>,
}

/// The owner's message `row` answering `bot`'s question `item_id` (§5.3
/// [L]), in one transaction: the row written with what it answers, and the
/// question waiting on the assistant to read it — its time cleared (an
/// answered question is not reminded of, nor brought up for a day), its
/// open reminder cards closed. Only while the question can still be
/// answered — this assistant's, a question, open or waiting, not waiting
/// on the assistant already — whatever else changed in it; `None`, nothing
/// written, when it cannot. The time it had is kept on the row
/// ([`AnswerPrior`], `tz` the owner's zone). `resent_from`: the row is that
/// owner row sent again, marked so in the same write — `None` too when it
/// was sent again already (two sends at once: one copy).
#[allow(clippy::too_many_arguments)]
pub async fn insert_owner_row_answering(
    conn: &DatabaseConnection,
    bot: i32,
    mut row: super::personal_agent_service::NewRow,
    item_id: i32,
    summary: &str,
    tz: chrono_tz::Tz,
    resent_from: Option<i32>,
) -> Result<Option<Answering>, DbError> {
    use crate::db::entities::personal_agent_item::ItemKind;
    use crate::db::entities::personal_agent_notice::NoticeKind;
    use super::personal_agent_service::reminder_subject;
    let now = Utc::now();
    let mut data = row.data.take().unwrap_or_else(|| serde_json::json!({}));
    data[ANSWERS_ITEM] = serde_json::json!({
        "id": item_id,
        "summary": summary,
        "linked_at": now,
    });
    row.data = Some(data);
    let txn = conn.begin().await?;
    let mut inserted = row.into_active(bot, now).insert(&txn).await?;
    let prior = item::Entity::find_by_id(item_id)
        .one(&txn)
        .await?
        .as_ref()
        .and_then(|i| AnswerPrior::of(i, tz));
    let linked = item::Entity::update_many()
        .col_expr(item::Column::Status, Expr::value(ItemStatus::Waiting))
        .col_expr(item::Column::WaitsFor, Expr::value(Some(WaitsFor::Agent)))
        .col_expr(item::Column::AnswerRowId, Expr::value(Some(inserted.id)))
        .col_expr(item::Column::AnswerState, Expr::value(Some("linked".to_string())))
        .col_expr(item::Column::DueAt, Expr::value(None::<DateTime<Utc>>))
        .col_expr(item::Column::Repeat, Expr::value(None::<String>))
        .col_expr(item::Column::AtDue, Expr::value(None::<String>))
        .col_expr(item::Column::ActSpec, Expr::value(None::<String>))
        .col_expr(item::Column::FiredAt, Expr::value(None::<DateTime<Utc>>))
        .col_expr(item::Column::UpdatedAt, Expr::value(now))
        .filter(item::Column::Id.eq(item_id))
        .filter(item::Column::BotId.eq(bot))
        .filter(item::Column::Kind.eq(ItemKind::Question))
        .filter(item::Column::Status.is_in([ItemStatus::Open, ItemStatus::Waiting]))
        .filter(
            sea_orm::Condition::any()
                .add(item::Column::WaitsFor.is_null())
                .add(item::Column::WaitsFor.ne(WaitsFor::Agent)),
        )
        .exec(&txn)
        .await?;
    if linked.rows_affected != 1 {
        txn.rollback().await?;
        return Ok(None);
    }
    if let Some(from) = resent_from {
        if !super::personal_agent_service::mark_resent(&txn, from, inserted.id).await? {
            txn.rollback().await?;
            return Ok(None);
        }
    }
    if let Some(p) = &prior {
        write_prior(&txn, inserted.id, Some(p)).await?;
        if let Some(r) = timeline::Entity::find_by_id(inserted.id).one(&txn).await? {
            inserted = r;
        }
    }
    let mut cards = Vec::new();
    let open = notice::Entity::find()
        .filter(notice::Column::BotId.eq(bot))
        .filter(notice::Column::Kind.eq(NoticeKind::Reminder))
        .filter(notice::Column::SubjectKey.eq(reminder_subject(item_id)))
        .filter(notice::Column::State.eq(NoticeState::Open))
        .all(&txn)
        .await?;
    for n in open {
        notice::Entity::update_many()
            .col_expr(notice::Column::State, Expr::value(NoticeState::Dismissed))
            .col_expr(notice::Column::ActedAt, Expr::value(Some(now)))
            .col_expr(notice::Column::UpdatedAt, Expr::value(now))
            .filter(notice::Column::Id.eq(n.id))
            .exec(&txn)
            .await?;
        let Some(card_id) = n.timeline_id else {
            continue;
        };
        let Some(card) = timeline::Entity::find_by_id(card_id).one(&txn).await? else {
            continue;
        };
        let mut d = row_data(&card);
        d["state"] = "closed".into();
        d["until"] = Value::Null;
        d["error"] = Value::Null;
        d["error_key"] = Value::Null;
        d["error_params"] = Value::Null;
        timeline::Entity::update_many()
            .col_expr(timeline::Column::Data, Expr::value(Some(d.to_string())))
            .col_expr(timeline::Column::UpdatedAt, Expr::value(now))
            .filter(timeline::Column::Id.eq(card_id))
            .exec(&txn)
            .await?;
        if let Some(c) = timeline::Entity::find_by_id(card_id).one(&txn).await? {
            cards.push(c);
        }
    }
    let Some(item) = item::Entity::find_by_id(item_id).one(&txn).await? else {
        txn.rollback().await?;
        return Ok(None);
    };
    txn.commit().await?;
    Ok(Some(Answering {
        row: inserted,
        item,
        cards,
    }))
}
