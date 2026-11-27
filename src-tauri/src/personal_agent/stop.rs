//! Stopping a piece of handed-out work (4.10): who stopped it, one
//! transaction that books the stop everywhere it shows — the dispatch, its
//! board task, a follow-up not sent yet, its card, its matter, its routine
//! run, its coding event, plan feedback not sent yet — and, once that is
//! committed, the teardown of what still runs. Each teardown step finds
//! nothing to do when run again; a crash between the two leaves nothing to
//! tear down, the processes having gone with codeg.
//!
//! Every stop goes this way, whoever asks: the owner on a card, in the
//! conversation, in the work's own session or on the board, and the
//! assistant itself (`dispatch_stop`). A stopped piece of work wakes nobody.

use chrono::{DateTime, Utc};
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseTransaction, EntityTrait, QueryFilter, QueryOrder,
    TransactionTrait,
};
use serde::Serialize;
use serde_json::{json, Value};

use super::dispatch::LIVE_STATES;
use super::engine::PersonalAgentEngine;
use crate::db::entities::personal_agent_dispatch::{self as dispatch_entity, DispatchMode, DispatchState};
use crate::db::entities::personal_agent_item::{self as item_entity, ItemStatus, WaitsFor};
use crate::db::entities::personal_agent_notice as notice_entity;
use crate::db::entities::personal_agent_routine_run::{self as run_entity, RunOutcome};
use crate::db::entities::personal_agent_timeline::{self as timeline, TimelineKind};
use crate::db::entities::work_task::{self as work_task_entity, WorkTaskStatus};
use crate::db::error::DbError;
use crate::db::service::personal_agent_service as svc;
use crate::db::service::personal_agent_watch_service as wsvc;
use crate::db::service::work_task_service as wts;
use crate::models::personal_agent::PersonalAgentChange;

/// Who stopped a piece of work.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoppedBy {
    /// The owner, on its card or with the conversation's [Stop].
    Owner,
    /// The owner, with [Stop] in the work's own session.
    OwnerInSession,
    /// The owner, canceling its task on the board.
    OwnerOnBoard,
    /// The assistant that handed it out (`dispatch_stop`), and why.
    Agent { reason: String },
}

/// The note a stopped dispatch keeps as its error — what an older codeg
/// wrote, and the start of every owner's note since.
const OWNER_NOTE: &str = "stopped by the owner";
const IN_SESSION: &str = " in its conversation";
const ON_BOARD: &str = " on the board";
const AGENT_NOTE: &str = "stopped by the assistant: ";

impl StoppedBy {
    /// Its name for machines: `owner`, `owner_in_session`, `owner_on_board`,
    /// `agent`.
    pub fn key(&self) -> &'static str {
        match self {
            StoppedBy::Owner => "owner",
            StoppedBy::OwnerInSession => "owner_in_session",
            StoppedBy::OwnerOnBoard => "owner_on_board",
            StoppedBy::Agent { .. } => "agent",
        }
    }

    /// From its [`Self::key`] (and the assistant's reason).
    pub fn from_key(key: &str, reason: Option<&str>) -> Option<Self> {
        Some(match key {
            "owner" => StoppedBy::Owner,
            "owner_in_session" => StoppedBy::OwnerInSession,
            "owner_on_board" => StoppedBy::OwnerOnBoard,
            "agent" => StoppedBy::Agent {
                reason: reason.unwrap_or_default().to_string(),
            },
            _ => return None,
        })
    }

    /// The note a dispatch it stopped keeps, for people to read.
    pub fn note(&self) -> String {
        match self {
            StoppedBy::Owner => OWNER_NOTE.to_string(),
            StoppedBy::OwnerInSession => format!("{OWNER_NOTE}{IN_SESSION}"),
            StoppedBy::OwnerOnBoard => format!("{OWNER_NOTE}{ON_BOARD}"),
            StoppedBy::Agent { reason } => format!("{AGENT_NOTE}{reason}"),
        }
    }

    /// Who a dispatch's note says stopped it — an older codeg's
    /// `stopped by the owner` too; `None` for any other error.
    pub fn parse(note: &str) -> Option<Self> {
        if let Some(reason) = note.strip_prefix(AGENT_NOTE) {
            return Some(StoppedBy::Agent {
                reason: reason.to_string(),
            });
        }
        match note.strip_prefix(OWNER_NOTE)? {
            "" => Some(StoppedBy::Owner),
            IN_SESSION => Some(StoppedBy::OwnerInSession),
            ON_BOARD => Some(StoppedBy::OwnerOnBoard),
            _ => None,
        }
    }

    /// The assistant's reason, when it stopped it.
    pub fn reason(&self) -> Option<&str> {
        match self {
            StoppedBy::Agent { reason } => Some(reason.as_str()),
            _ => None,
        }
    }

    /// Who settles its matter.
    pub fn closer(&self) -> svc::Closer {
        match self {
            StoppedBy::Agent { .. } => svc::Closer::Agent,
            _ => svc::Closer::Owner,
        }
    }

    /// Whose cancel it is on the board.
    pub fn actor(&self) -> &'static str {
        match self {
            StoppedBy::Agent { .. } => "assistant",
            _ => "user",
        }
    }

    /// Who stopped it, as the assistant reads it.
    pub fn words(&self) -> String {
        match self {
            StoppedBy::Owner => "the owner".into(),
            StoppedBy::OwnerInSession => "the owner, in the work's own session".into(),
            StoppedBy::OwnerOnBoard => "the owner, on the board".into(),
            StoppedBy::Agent { reason } if reason.trim().is_empty() => "you".into(),
            StoppedBy::Agent { reason } => format!("you ({reason})"),
        }
    }
}

/// Who stopped dispatch `d`, when it is a stopped one: canceled with a
/// stop's note.
pub fn stopped_by_of(d: &dispatch_entity::Model) -> Option<StoppedBy> {
    if d.state != DispatchState::Canceled {
        return None;
    }
    StoppedBy::parse(d.error.as_deref()?)
}

/// Who a board task's cancel stopped its work as: a personal agent's stop
/// by whom it records; the owner's own on the board; nobody's for the
/// board engine's own cancel.
pub fn board_stop_of(r: &wts::CancelRecord) -> Option<StoppedBy> {
    if let Some((_, by)) = &r.pa_stop {
        return StoppedBy::from_key(by, None);
    }
    (r.actor == "user").then_some(StoppedBy::OwnerOnBoard)
}

/// What a stop came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopOutcome {
    /// Stopped now; `updated_at` is the dispatch as the stop wrote it.
    Stopped {
        by: StoppedBy,
        updated_at: DateTime<Utc>,
    },
    /// Stopped already, by `by`.
    AlreadyStopped { by: StoppedBy },
    /// Past stopping (done, failed, merging, taken over): `state`.
    PastStopping { state: DispatchState },
    /// The board would not cancel its task (merging, done): nothing written.
    BoardRefused,
    /// Changed since the card that asked read it: nothing written.
    Changed,
}

/// [`StopOutcome`] as the page and the tool read it.
#[derive(Debug, Clone, Serialize)]
pub struct StopReply {
    /// `stopped`, `already_stopped`, `past_stopping`, `board_refused`,
    /// `changed`.
    pub outcome: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub by: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<DispatchState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime<Utc>>,
}

impl From<&StopOutcome> for StopReply {
    fn from(o: &StopOutcome) -> Self {
        let reply = |outcome| StopReply {
            outcome,
            by: None,
            reason: None,
            state: None,
            updated_at: None,
        };
        match o {
            StopOutcome::Stopped { by, updated_at } => StopReply {
                by: Some(by.key()),
                reason: by.reason().map(str::to_string),
                updated_at: Some(*updated_at),
                ..reply("stopped")
            },
            StopOutcome::AlreadyStopped { by } => StopReply {
                by: Some(by.key()),
                reason: by.reason().map(str::to_string),
                ..reply("already_stopped")
            },
            StopOutcome::PastStopping { state } => StopReply {
                state: Some(*state),
                ..reply("past_stopping")
            },
            StopOutcome::BoardRefused => reply("board_refused"),
            StopOutcome::Changed => reply("changed"),
        }
    }
}

/// What a card's [Stop] read (5.7): the dispatch's version, and its board
/// task's run and version. A stop from anywhere else passes none.
#[derive(Debug, Clone, Copy, Default)]
pub struct StopExpect {
    pub updated_at: Option<DateTime<Utc>>,
    pub run_seq: Option<i32>,
    pub task_updated_at: Option<DateTime<Utc>>,
}

/// What a stop card shows that is read before the stop's transaction (its
/// reads are not the stop's to hold the write lock over).
#[derive(Debug, Clone, Default)]
pub(super) struct CardFacts {
    segment_id: Option<i32>,
    reply_to: Option<i32>,
    conversation_folder_id: Option<i32>,
    task: Option<work_task_entity::Model>,
}

/// What booking a stop wrote, to show once it is committed.
#[derive(Debug, Clone, Default)]
pub(super) struct Booked {
    card: Option<timeline::Model>,
    item: Option<i32>,
    routine: Option<i32>,
    asks: Vec<timeline::Model>,
}

impl PersonalAgentEngine {
    /// The stop card's facts read ahead of the stop.
    pub(super) async fn stop_card_facts(&self, d: &dispatch_entity::Model) -> CardFacts {
        let reply_to = match d.source_batch_id {
            Some(b) => svc::anchor_row_of_batch(&self.db.conn, b)
                .await
                .ok()
                .flatten()
                .map(|r| r.id),
            None => None,
        };
        let conversation_folder_id = match d.conversation_id {
            Some(cid) => crate::db::service::conversation_service::get_by_id(&self.db.conn, cid)
                .await
                .ok()
                .map(|c| c.folder_id),
            None => None,
        };
        let task = match d.work_task_id {
            Some(t) => wts::get_model(&self.db.conn, t).await.ok(),
            None => None,
        };
        CardFacts {
            segment_id: self.state.lock().await.connection_segment,
            reply_to,
            conversation_folder_id,
            task,
        }
    }

    /// Stop dispatch `d` as `by` asks (P5.3): `expect`, what a card read.
    /// `Err` only when nothing could be written (the database failed): the
    /// caller says so — it is no "not ours", and nothing else may cancel the
    /// work in its place.
    pub async fn stop_dispatch_as(
        &self,
        d: &dispatch_entity::Model,
        by: StoppedBy,
        expect: StopExpect,
    ) -> Result<StopOutcome, String> {
        let bot = self.bot().await;
        if d.bot_id != Some(bot) {
            return Err(format!("dispatch #{} is not this assistant's", d.id));
        }
        // codeg's own checks (7.5, 10.3) are told to their own progress,
        // not booked as the assistant's work.
        let check = self.check_round_of(d.id).await.is_some() || self.fact_check_of(d.id).await.is_some();
        let facts = self.stop_card_facts(d).await;
        let txn = self.db.conn.begin().await.map_err(|e| e.to_string())?;
        let booked = self.stop_in(&txn, bot, d, by, expect, check, &facts).await;
        let (outcome, updated, run, op, booked) = match booked {
            Ok(Some(done)) => done,
            Ok(None) | Err(_) => {
                let _ = txn.rollback().await;
                return match booked {
                    Err(e) => Err(e.to_string()),
                    _ => self.why_not_stopped(d.id, expect).await,
                };
            }
        };
        if let StopOutcome::BoardRefused | StopOutcome::Changed = outcome {
            let _ = txn.rollback().await;
            return Ok(outcome);
        }
        txn.commit().await.map_err(|e| e.to_string())?;
        let by = match &outcome {
            StopOutcome::Stopped { by, .. } | StopOutcome::AlreadyStopped { by } => by.clone(),
            _ => unreachable!("only stops are committed"),
        };
        self.finish_stop(&updated, &by, run, op, booked, check).await;
        Ok(outcome)
    }

    /// Why dispatch `id` was not stopped by a stop that did not write it.
    async fn why_not_stopped(&self, id: i32, expect: StopExpect) -> Result<StopOutcome, String> {
        let now = svc::get_dispatch(&self.db.conn, id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("no dispatch #{id}"))?;
        if let Some(by) = stopped_by_of(&now) {
            return Ok(StopOutcome::AlreadyStopped { by });
        }
        if LIVE_STATES.contains(&now.state) && expect.updated_at.is_some() {
            return Ok(StopOutcome::Changed);
        }
        Ok(StopOutcome::PastStopping { state: now.state })
    }

    /// The stop's transaction: `None` when the dispatch's own write did not
    /// take (it is not live, or changed). Else what the stop came to, the
    /// dispatch as written, the board run it ended, the follow-up it took
    /// back, and what it booked.
    #[allow(clippy::too_many_arguments, clippy::type_complexity)]
    async fn stop_in(
        &self,
        txn: &DatabaseTransaction,
        bot: i32,
        d: &dispatch_entity::Model,
        by: StoppedBy,
        expect: StopExpect,
        check: bool,
        facts: &CardFacts,
    ) -> Result<Option<(StopOutcome, dispatch_entity::Model, Option<i32>, Option<String>, Booked)>, DbError>
    {
        let now = Utc::now();
        // First statement, a write: the transaction holds the write lock from
        // here, so nothing read below changes before it commits.
        let mut write = dispatch_entity::Entity::update_many()
            .col_expr(dispatch_entity::Column::State, Expr::value(DispatchState::Canceled))
            .col_expr(dispatch_entity::Column::Error, Expr::value(Some(by.note())))
            .col_expr(dispatch_entity::Column::Followup, Expr::value(None::<String>))
            .col_expr(dispatch_entity::Column::FinishedAt, Expr::value(Some(now)))
            .col_expr(dispatch_entity::Column::UpdatedAt, Expr::value(now))
            .filter(dispatch_entity::Column::Id.eq(d.id))
            .filter(dispatch_entity::Column::BotId.eq(bot))
            .filter(dispatch_entity::Column::State.is_in(LIVE_STATES.to_vec()));
        if let Some(at) = expect.updated_at {
            write = write.filter(dispatch_entity::Column::UpdatedAt.eq(at));
        }
        if write.exec(txn).await?.rows_affected != 1 {
            return Ok(None);
        }
        // Read again in the transaction: what it runs on as it is now — a
        // follow-up claimed on a new connection, an op just put on it.
        let mut updated = dispatch_entity::Entity::find_by_id(d.id)
            .one(txn)
            .await?
            .ok_or_else(|| DbError::NotFound(format!("dispatch #{}", d.id)))?;
        let mut by = by;
        let mut already = false;
        let mut run = None;
        if updated.mode == DispatchMode::Task {
            if let Some(task_id) = updated.work_task_id {
                let task = work_task_entity::Entity::find_by_id(task_id).one(txn).await?;
                // Put back to do (same run, not queued yet): only the version
                // the card read tells it apart.
                let todo_version = match &task {
                    Some(t) if t.status == WorkTaskStatus::Todo => expect.task_updated_at,
                    _ => None,
                };
                let canceled = wts::cancel_in(
                    txn,
                    task_id,
                    wts::CANCELABLE,
                    expect.run_seq,
                    todo_version,
                    by.actor(),
                    by.reason(),
                    Some(wts::PaStop {
                        dispatch_id: d.id,
                        by: by.key().to_string(),
                    }),
                )
                .await?;
                match canceled {
                    Some(r) => run = Some(r),
                    None => {
                        let t = work_task_entity::Entity::find_by_id(task_id).one(txn).await?;
                        match t {
                            Some(t) if t.status == WorkTaskStatus::Canceled => {
                                run = Some(t.run_seq);
                                let record = wts::latest_cancel_of_run(txn, task_id, t.run_seq).await?;
                                // The owner canceled it on the board first: that
                                // is the stop, said so everywhere.
                                if record.as_ref().and_then(board_stop_of) == Some(StoppedBy::OwnerOnBoard)
                                {
                                    by = StoppedBy::OwnerOnBoard;
                                    already = true;
                                    dispatch_entity::Entity::update_many()
                                        .col_expr(dispatch_entity::Column::Error, Expr::value(Some(by.note())))
                                        .filter(dispatch_entity::Column::Id.eq(d.id))
                                        .exec(txn)
                                        .await?;
                                    updated.error = Some(by.note());
                                }
                            }
                            Some(t)
                                if expect.run_seq.is_some_and(|r| r != t.run_seq)
                                    || todo_version.is_some_and(|v| v != t.updated_at) =>
                            {
                                return Ok(Some((StopOutcome::Changed, updated, None, None, Booked::default())));
                            }
                            _ => {
                                return Ok(Some((StopOutcome::BoardRefused, updated, None, None, Booked::default())));
                            }
                        }
                    }
                }
            }
        }
        // A follow-up not sent yet is never sent: the ledger lets one of the
        // stop and the send have it.
        let mut op = None;
        if let Some(op_id) = updated.round_op_id.clone() {
            if svc::op_unattempted_to_not_executed(txn, &op_id, "stopped").await? {
                op = Some(op_id);
            }
        }
        let booked = if check {
            Booked::default()
        } else {
            book_stop(txn, bot, &updated, &by, run, facts).await?
        };
        let outcome = if already {
            StopOutcome::AlreadyStopped { by }
        } else {
            StopOutcome::Stopped {
                by,
                updated_at: updated.updated_at,
            }
        };
        Ok(Some((outcome, updated, run, op, booked)))
    }

    /// What follows a committed stop: shown, and what still runs torn down.
    pub(super) async fn finish_stop(
        &self,
        d: &dispatch_entity::Model,
        by: &StoppedBy,
        run: Option<i32>,
        op: Option<String>,
        booked: Booked,
        check: bool,
    ) {
        let mut rows: Vec<timeline::Model> = booked.card.into_iter().collect();
        rows.extend(booked.asks);
        // Each row to its own assistant's page: a mirror of the plan card is
        // the other assistant's.
        let me = self.bot().await;
        for row in rows {
            let bot = row.bot_id.unwrap_or(me);
            let row = svc::to_row(row);
            if bot == me {
                self.emit_rows(vec![row]);
            } else {
                self.emit_for(bot, PersonalAgentChange::Timeline { rows: vec![row] });
                self.emit_for(bot, PersonalAgentChange::Status);
            }
        }
        if let Some(item) = booked.item {
            self.emit(PersonalAgentChange::Item { id: item });
        }
        if let Some(routine) = booked.routine {
            self.emit(PersonalAgentChange::Routine { id: routine });
        }
        match (d.mode, d.work_task_id, run) {
            (DispatchMode::Task, Some(task), Some(run)) => {
                if let Some(board) = crate::work_task::engine() {
                    board.teardown_canceled(task, run).await;
                }
            }
            (DispatchMode::Task, _, _) => {}
            _ => {
                if let Some(conn) = d.connection_id.as_deref() {
                    let _ = self.manager.cancel(&self.db.conn, conn).await;
                }
            }
        }
        if let Some(op) = op {
            self.set_live(&op, false).await;
            self.after_op(&op, &super::ledger::OpOutcome::NotExecuted("stopped".into()))
                .await;
        }
        self.close_stopped_asks(d.id, by).await;
        self.plan_dispatch_moved(d.id).await;
        if check {
            self.record_progress(d, None, Some(by.note()), "stopped").await;
        }
        self.emit(PersonalAgentChange::Dispatch { id: d.id });
        self.emit(PersonalAgentChange::Status);
    }

    /// The executor's questions still open on stopped dispatch `id`, closed
    /// as `sweep_asks` closes one whose request went: an answer already
    /// submitted is kept (its feedback goes nowhere — the work is stopped),
    /// one with none is withdrawn, saying who stopped the work.
    pub(super) async fn close_stopped_asks(&self, id: i32, by: &StoppedBy) {
        let bot = self.bot().await;
        for n in svc::open_asks(&self.db.conn, Some(bot)).await.unwrap_or_default() {
            let Some(card) = super::asks::AskCard::read(&n.payload) else {
                continue;
            };
            if card.dispatch_id != id {
                continue;
            }
            self.close_ask_of_stopped(n.id, &card, by).await;
        }
    }

    /// Ask `ask_id` (its card `card`) of stopped work, closed (see
    /// [`Self::close_stopped_asks`]).
    pub(super) async fn close_ask_of_stopped(
        &self,
        ask_id: i32,
        card: &super::asks::AskCard,
        by: &StoppedBy,
    ) {
        let resolution = self
            .manager
            .resolution_of(&card.request_id)
            .unwrap_or_else(crate::acp::types::AnswerResolution::withdrawn);
        if card.request == "plan_permission" {
            self.settle_permission_ask(&card.conn, &card.request_id, None, None)
                .await;
        } else {
            self.settle_ask(&card.conn, &card.request_id, Some(resolution))
                .await;
        }
        // Withdrawn: says who stopped the work, not only that it went.
        if let Some(mut now) = self.ask_card(ask_id).await {
            if now.state == "withdrawn" && now.stopped_by.is_none() {
                now.stopped_by = Some(by.key().to_string());
                now.stop_reason = by.reason().map(str::to_string);
                let _ = self.write_ask(ask_id, &now).await;
            }
        }
    }
}

/// Book the stop of `d` (written Canceled already, in `txn`) as `by` did it
/// (P5.3, 1.4): its card, its matter given up, its routine run stopped, its
/// coding event, its plan feedback not sent yet dropped. `run`: the board
/// run it ended. Every stop books here once, the board's cancels too.
pub(super) async fn book_stop(
    txn: &DatabaseTransaction,
    bot: i32,
    d: &dispatch_entity::Model,
    by: &StoppedBy,
    run: Option<i32>,
    facts: &CardFacts,
) -> Result<Booked, DbError> {
    let now = Utc::now();
    let work = super::dispatch::work_of(d);
    let ladder = super::ladder::ladder_of(d, facts.task.as_ref());
    let note = by.note();
    let round = match d.mode {
        DispatchMode::Task => run.unwrap_or(0),
        _ => d.turns,
    };
    // Its card: the result row of a stop, as every stop wrote it.
    let summary = format!(
        "Dispatch #{} \"{}\" ({}) {}. ({note})",
        d.id,
        d.title,
        super::dispatch::mode_label(d.mode),
        super::dispatch::state_sentence(DispatchState::Canceled)
    );
    let mut card = svc::NewRow::new(TimelineKind::Result, summary);
    card.dispatch_id = Some(d.id);
    card.segment_id = facts.segment_id;
    card.reply_to = facts.reply_to;
    card.data = Some(json!({
        "mode": d.mode,
        "state": DispatchState::Canceled,
        "ladder": ladder,
        "title": d.title,
        "agent_type": work.agent_type,
        "excerpt": d.result_excerpt,
        "gist": d.result_excerpt.as_deref().and_then(super::gist::plain_gist),
        "note": note,
        "cause": "stopped",
        "work_task_id": d.work_task_id,
        "run": run,
        "round": round,
        "merge_commit": Value::Null,
        "conversation_id": d.conversation_id,
        "conversation_folder_id": facts.conversation_folder_id,
        "folder_id": d.folder_id,
        "auto_retry": Value::Null,
        "stopped_by": by.key(),
        "reason": by.reason(),
    }));
    let card = card.into_active(bot, now).insert(txn).await?;
    // Its matter: given up — so a later result of the same work (a
    // follow-up, the board running it again) still moves it.
    let mut item = None;
    if let Some(i) = item_entity::Entity::find()
        .filter(item_entity::Column::DispatchId.eq(d.id))
        .order_by_asc(item_entity::Column::Id)
        .one(txn)
        .await?
    {
        if matches!(i.status, ItemStatus::Open | ItemStatus::Waiting) {
            svc::closing_exprs(
                item_entity::Entity::update_many(),
                ItemStatus::Dropped,
                Some(svc::Closing::new(by.closer(), "stopped")),
                now,
            )
            .col_expr(item_entity::Column::Status, Expr::value(ItemStatus::Dropped))
            .col_expr(item_entity::Column::WaitsFor, Expr::value(None::<WaitsFor>))
            .col_expr(item_entity::Column::UpdatedAt, Expr::value(now))
            .filter(item_entity::Column::Id.eq(i.id))
            .filter(item_entity::Column::Status.is_in([ItemStatus::Open, ItemStatus::Waiting]))
            .exec(txn)
            .await?;
            item = Some(i.id);
        }
    }
    // Its routine run: stopped, as the last word on it.
    let mut routine = None;
    if let Some(r) = run_entity::Entity::find()
        .filter(run_entity::Column::DispatchId.eq(d.id))
        .order_by_desc(run_entity::Column::Id)
        .one(txn)
        .await?
    {
        if r.outcome != RunOutcome::Stopped {
            run_entity::Entity::update_many()
                .col_expr(run_entity::Column::Outcome, Expr::value(RunOutcome::Stopped))
                .col_expr(run_entity::Column::EndedAt, Expr::value(Some(now)))
                .col_expr(run_entity::Column::Note, Expr::value(None::<String>))
                .filter(run_entity::Column::Id.eq(r.id))
                .filter(run_entity::Column::Outcome.ne(RunOutcome::Stopped))
                .exec(txn)
                .await?;
            routine = Some(r.routine_id);
        }
    }
    // Its coding event (6.9): written with the stop, or the stop fails.
    wsvc::record_signal(
        txn,
        wsvc::NewSignal {
            kind: "dispatch_ended",
            key: format!(
                "dispatch:{}:{}:canceled:stopped:{}",
                d.id,
                d.turns,
                d.updated_at.timestamp_nanos_opt().unwrap_or_default()
            ),
            bot_id: d.bot_id,
            folder_id: d.folder_id,
            facts: json!({
                "dispatch_id": d.id,
                "title": d.title,
                "mode": d.mode,
                "state": DispatchState::Canceled,
                "ladder": ladder,
                "work_task_id": d.work_task_id,
                "conversation_id": d.conversation_id,
                "cause": "stopped",
                "stopped_by": by.key(),
                "reason": by.reason(),
            }),
        },
    )
    .await?;
    let asks = drop_unsent_feedback(txn, d.id, by).await?;
    Ok(Booked {
        card: Some(card),
        item,
        routine,
        asks,
    })
}

/// Plan feedback of stopped work `dispatch_id` kept to send and not sent
/// yet: never sent now (`feedback_sent`, said so: `feedback_dropped`) —
/// on the card, its row and its mirrors, as `write_ask` writes them. The
/// rows written.
async fn drop_unsent_feedback(
    txn: &DatabaseTransaction,
    dispatch_id: i32,
    by: &StoppedBy,
) -> Result<Vec<timeline::Model>, DbError> {
    let rows = timeline::Entity::find()
        .filter(timeline::Column::Kind.eq(TimelineKind::Notice))
        .filter(timeline::Column::DispatchId.eq(dispatch_id))
        .filter(Expr::cust("json_extract(data, '$.notice') = 'ask'"))
        .filter(Expr::cust("json_extract(data, '$.state') = 'answered'"))
        .filter(Expr::cust("json_extract(data, '$.feedback') IS NOT NULL"))
        .filter(Expr::cust("COALESCE(json_extract(data, '$.feedback_sent'), 0) = 0"))
        .filter(Expr::cust("json_extract(data, '$.mirror_of') IS NULL"))
        .all(txn)
        .await?;
    let mut written = Vec::new();
    for row in rows {
        let Some(card) = row
            .data
            .as_deref()
            .and_then(super::asks::AskCard::read)
        else {
            continue;
        };
        let mark = |v: &mut Value| {
            v["feedback_sent"] = true.into();
            v["feedback_dropped"] = "stopped".into();
            v["stopped_by"] = by.key().into();
            v["stop_reason"] = by.reason().into();
        };
        let mut targets = vec![row.id];
        targets.extend(card.mirrors.iter().filter_map(|m| {
            m.get("row_id").and_then(Value::as_i64).and_then(|v| i32::try_from(v).ok())
        }));
        for id in targets {
            let Some(r) = timeline::Entity::find_by_id(id).one(txn).await? else {
                continue;
            };
            let mut v: Value = r
                .data
                .as_deref()
                .and_then(|d| serde_json::from_str(d).ok())
                .unwrap_or_else(|| json!({}));
            mark(&mut v);
            timeline::Entity::update_many()
                .col_expr(timeline::Column::Data, Expr::value(Some(v.to_string())))
                .col_expr(timeline::Column::UpdatedAt, Expr::value(Utc::now()))
                .filter(timeline::Column::Id.eq(id))
                .exec(txn)
                .await?;
            if let Some(r) = timeline::Entity::find_by_id(id).one(txn).await? {
                written.push(r);
            }
        }
        if let Some(n) = notice_entity::Entity::find_by_id(card.ask_id).one(txn).await? {
            let mut v: Value = serde_json::from_str(&n.payload).unwrap_or_else(|_| json!({}));
            mark(&mut v);
            notice_entity::Entity::update_many()
                .col_expr(notice_entity::Column::Payload, Expr::value(v.to_string()))
                .filter(notice_entity::Column::Id.eq(n.id))
                .exec(txn)
                .await?;
        }
    }
    Ok(written)
}


/// The states a board cancel of the owner's is booked from: live, or ended
/// in a way the board still lets one cancel (failed, interrupted).
const BOARD_CANCELABLE: &[DispatchState] = &[
    DispatchState::Queued,
    DispatchState::Running,
    DispatchState::WaitingInput,
    DispatchState::Review,
    DispatchState::Failed,
    DispatchState::Interrupted,
];

impl PersonalAgentEngine {
    /// Task dispatch `d`'s board task, canceled: when the owner canceled it
    /// on the board — this run's latest cancel is theirs — book it as their
    /// stop (D3): no news, nobody woken, its matter given up. `true` when
    /// the cancel is a stop's (booked now, or a stop of this codeg's own),
    /// so a plain sync does not tell it as news; `false` for anything else
    /// (the board engine's own cancel, an older cancel nothing records the
    /// run of, a task not canceled), left to the plain sync. Every look at
    /// the board books here — the poll, the board's scan, the feedback
    /// sender, the takeover sweep — and only the first one does.
    pub(super) async fn book_board_cancel(&self, d: &dispatch_entity::Model) -> bool {
        let Some(task_id) = d.work_task_id else {
            return false;
        };
        // Deleted since, too: the board cancels before it deletes.
        let task = match work_task_entity::Entity::find_by_id(task_id).one(&self.db.conn).await {
            Ok(Some(t)) if t.status == WorkTaskStatus::Canceled => t,
            _ => return false,
        };
        let record = match wts::latest_cancel_of_run(&self.db.conn, task_id, task.run_seq).await {
            Ok(Some(r)) => r,
            _ => return false,
        };
        if record.pa_stop.is_some() {
            return true;
        }
        if board_stop_of(&record) != Some(StoppedBy::OwnerOnBoard) {
            return false;
        }
        let by = StoppedBy::OwnerOnBoard;
        let bot = self.bot().await;
        let facts = self.stop_card_facts(d).await;
        let booked: Result<Option<(dispatch_entity::Model, Option<String>, Booked)>, DbError> = async {
            let txn = self.db.conn.begin().await?;
            let now = Utc::now();
            let wrote = dispatch_entity::Entity::update_many()
                .col_expr(dispatch_entity::Column::State, Expr::value(DispatchState::Canceled))
                .col_expr(dispatch_entity::Column::Error, Expr::value(Some(by.note())))
                .col_expr(dispatch_entity::Column::Followup, Expr::value(None::<String>))
                .col_expr(dispatch_entity::Column::FinishedAt, Expr::value(Some(now)))
                .col_expr(dispatch_entity::Column::UpdatedAt, Expr::value(now))
                .filter(dispatch_entity::Column::Id.eq(d.id))
                .filter(dispatch_entity::Column::State.is_in(BOARD_CANCELABLE.to_vec()))
                .exec(&txn)
                .await?;
            if wrote.rows_affected != 1 {
                txn.rollback().await?;
                return Ok(None);
            }
            // Still that run's cancel: queued again meanwhile, it is not.
            let now_task = work_task_entity::Entity::find_by_id(task_id).one(&txn).await?;
            if !now_task.is_some_and(|t| t.status == WorkTaskStatus::Canceled && t.run_seq == task.run_seq) {
                txn.rollback().await?;
                return Ok(None);
            }
            let updated = dispatch_entity::Entity::find_by_id(d.id)
                .one(&txn)
                .await?
                .ok_or_else(|| DbError::NotFound(format!("dispatch #{}", d.id)))?;
            let mut op = None;
            if let Some(op_id) = updated.round_op_id.clone() {
                if svc::op_unattempted_to_not_executed(&txn, &op_id, "stopped").await? {
                    op = Some(op_id);
                }
            }
            let booked = book_stop(&txn, bot, &updated, &by, Some(task.run_seq), &facts).await?;
            txn.commit().await?;
            Ok(Some((updated, op, booked)))
        }
        .await;
        match booked {
            Ok(Some((updated, op, booked))) => {
                // The board tore its own run down: only the stop's
                // questions, follow-up and plan are left to settle.
                self.finish_stop(&updated, &by, None, op, booked, false).await;
                true
            }
            Ok(None) => {
                // Booked by another look first, or past booking.
                svc::get_dispatch(&self.db.conn, d.id)
                    .await
                    .ok()
                    .flatten()
                    .as_ref()
                    .and_then(stopped_by_of)
                    .is_some()
            }
            Err(e) => {
                tracing::warn!("[personal_agent] the owner's cancel of dispatch #{} not booked: {e}", d.id);
                true
            }
        }
    }
}

/// How stopped (or ended) work goes on, for the assistant (P5.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResumeHint {
    /// Its session is there to go on in: a follow-up.
    Followup,
    /// Handed out anew, taking it over (`replaces`).
    Replace,
    /// A round codeg runs itself on a watched pull request.
    CodegOwn,
    None,
}

impl ResumeHint {
    /// Its machine name.
    pub fn key(self) -> Option<&'static str> {
        match self {
            ResumeHint::Followup => Some("followup"),
            ResumeHint::Replace => Some("replace"),
            ResumeHint::CodegOwn => Some("codeg_own"),
            ResumeHint::None => None,
        }
    }

    /// What to do, for the assistant to read: about dispatch `id`.
    pub fn sentence(self, id: i32) -> String {
        match self {
            ResumeHint::Followup => format!(
                " To go on with it, follow it up with `dispatch_followup` (dispatch_id {id}): \
                 it picks up in the same session."
            ),
            ResumeHint::Replace => format!(
                " To do it again, `dispatch` it anew with `replaces: {id}`: the new work takes its \
                 matter over."
            ),
            ResumeHint::CodegOwn => " codeg ran this round itself on a watched pull request; its \
                 watch tells you what comes of the pull request."
                .to_string(),
            ResumeHint::None => String::new(),
        }
    }
}

impl PersonalAgentEngine {
    /// How dispatch `d` goes on now that it ended (stopped, say).
    pub(super) async fn resume_hint(&self, d: &dispatch_entity::Model) -> ResumeHint {
        // A round codeg runs on a watched pull request is codeg's to run
        // again — `replaces` does not take one over.
        if d.pr_fix.is_some() || super::pr_auto::pushed_or_pushing(d) {
            return ResumeHint::CodegOwn;
        }
        if d.mode != DispatchMode::Task && self.resumable(d).await {
            return ResumeHint::Followup;
        }
        if matches!(
            d.state,
            DispatchState::Canceled | DispatchState::Failed | DispatchState::Interrupted
        ) && d.replaced_by.is_none()
        {
            return ResumeHint::Replace;
        }
        ResumeHint::None
    }
}

/// The owner pressed [Stop] in conversation `connection_id` (P5.4, D2):
/// when it is the session of a piece of work an assistant handed out (a
/// chat or session dispatch, running or waiting for input), that is the
/// owner stopping the work — booked as their stop, the turn canceled with
/// it, nobody woken, nothing handed over. `Ok(false)`: not such work, the
/// caller cancels as for any conversation. `Err`: it is, and the stop could
/// not be written — the caller says so rather than cancel it plainly (that
/// would wake the assistant). A board task's session keeps the board's own
/// meaning.
pub async fn note_owner_cancel(connection_id: &str) -> Result<bool, String> {
    let Some(host) = super::host::host() else {
        return Ok(false);
    };
    let db = &host.db;
    let d = dispatch_entity::Entity::find()
        .filter(dispatch_entity::Column::ConnectionId.eq(connection_id))
        .filter(dispatch_entity::Column::Mode.ne(DispatchMode::Task))
        .filter(dispatch_entity::Column::State.is_in([DispatchState::Running, DispatchState::WaitingInput]))
        .order_by_desc(dispatch_entity::Column::Id)
        .one(&db.conn)
        .await
        .map_err(|e| e.to_string())?;
    let Some(d) = d else {
        return Ok(false);
    };
    let Some(engine) = host.engine_for(d.bot_id).await else {
        return Ok(false);
    };
    match engine
        .stop_dispatch_as(&d, StoppedBy::OwnerInSession, StopExpect::default())
        .await?
    {
        StopOutcome::Stopped { .. } | StopOutcome::AlreadyStopped { .. } => Ok(true),
        // Ended meanwhile: a plain cancel is all there is left to do.
        _ => Ok(false),
    }
}

impl PersonalAgentEngine {
    /// Who stopped dispatch `dispatch_id`, when ask card row `card_row` was
    /// raised before that stop (its row older than the dispatch's latest
    /// stop card): feedback kept on it is of the work the stop ended, and
    /// goes nowhere. `None`: not stopped, or the card came after (a run the
    /// owner queued again on the board asks anew).
    pub(super) async fn stopped_before_card(
        &self,
        dispatch_id: i32,
        card_row: Option<i32>,
    ) -> Option<StoppedBy> {
        let d = svc::get_dispatch(&self.db.conn, dispatch_id).await.ok().flatten()?;
        let by = stopped_by_of(&d)?;
        let stop_card = timeline::Entity::find()
            .filter(timeline::Column::Kind.eq(TimelineKind::Result))
            .filter(timeline::Column::DispatchId.eq(dispatch_id))
            .filter(Expr::cust("json_extract(data, '$.cause') = 'stopped'"))
            .order_by_desc(timeline::Column::Id)
            .one(&self.db.conn)
            .await
            .ok()
            .flatten();
        match (card_row, stop_card) {
            (Some(row), Some(stop)) if row < stop.id => Some(by),
            // An older stop wrote no card of its own (before the cards said
            // who): any card is from before it.
            (_, None) => Some(by),
            _ => None,
        }
    }
}

/// Feedback on ask card `card` that goes nowhere: its work was stopped
/// (`by`) — marked sent, and why not (`feedback_dropped`).
pub(super) fn drop_feedback(card: &mut super::asks::AskCard, by: &StoppedBy) {
    if card.feedback.is_some() {
        card.feedback_sent = true;
        card.feedback_dropped = Some("stopped".into());
        card.stopped_by = Some(by.key().to_string());
        card.stop_reason = by.reason().map(str::to_string);
    }
}

/// Longest reason the assistant gives for a stop, in characters.
pub const MAX_STOP_REASON_CHARS: usize = 200;

impl PersonalAgentEngine {
    /// `dispatch_stop` (P5.6): the assistant stops one of its own pieces of
    /// work, saying why. Not on the ledger: a second call finds it stopped.
    pub(super) async fn dispatch_stop_call(&self, args: &Value) -> super::tools::ToolOutcome {
        use super::tools::ToolOutcome;
        let Some(id) = args
            .get("dispatch_id")
            .and_then(Value::as_i64)
            .and_then(|v| i32::try_from(v).ok())
        else {
            return ToolOutcome::refused("`dispatch_id` is required");
        };
        let reason: String = args
            .get("reason")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .chars()
            .take(MAX_STOP_REASON_CHARS)
            .collect();
        if reason.is_empty() {
            return ToolOutcome::refused("`reason` is required: say why, for the owner's card");
        }
        let d = match svc::get_dispatch(&self.db.conn, id).await {
            Ok(Some(d)) => d,
            Ok(None) => return ToolOutcome::refused(format!("dispatch #{id} does not exist")),
            Err(e) => return ToolOutcome::refused(e.to_string()),
        };
        if d.bot_id != Some(self.bot().await) {
            return ToolOutcome::refused(format!(
                "dispatch #{id} is another assistant's: it is theirs to stop"
            ));
        }
        let outcome = match self
            .stop_dispatch_as(&d, StoppedBy::Agent { reason }, StopExpect::default())
            .await
        {
            Ok(o) => o,
            Err(e) => return ToolOutcome::refused(format!("dispatch #{id} could not be stopped: {e}")),
        };
        let now = svc::get_dispatch(&self.db.conn, id).await.ok().flatten().unwrap_or(d);
        let hint = self.resume_hint(&now).await;
        let data = json!({
            "dispatch_id": id,
            "stop": StopReply::from(&outcome),
            "resume_hint": hint.key(),
        });
        match outcome {
            StopOutcome::Stopped { .. } => ToolOutcome::ok(
                format!(
                    "Stopped dispatch #{id}: its matter is given up and the owner sees you stopped \
                     it and why. Nobody is woken by it.{}",
                    hint.sentence(id)
                ),
                data,
            ),
            StopOutcome::AlreadyStopped { by } => ToolOutcome::ok(
                format!("Dispatch #{id} was stopped already, by {}.{}", by.words(), hint.sentence(id)),
                data,
            ),
            StopOutcome::PastStopping { state } => ToolOutcome::refused_with(
                format!(
                    "Dispatch #{id} is past stopping ({}): nothing was changed.",
                    super::engine::enum_str(&state)
                ),
                data,
            ),
            StopOutcome::BoardRefused => ToolOutcome::refused_with(
                format!(
                    "Dispatch #{id}'s board task cannot be canceled now (it is merging, or done): \
                     nothing was changed."
                ),
                data,
            ),
            StopOutcome::Changed => ToolOutcome::refused_with(
                format!("Dispatch #{id} changed meanwhile: look at it again with item_read."),
                data,
            ),
        }
    }
}
