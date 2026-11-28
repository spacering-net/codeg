//! What the activity list needs beyond "today" (6.2), read from the
//! database alone — the same snapshot whether or not the assistants run in
//! this process: where each input an assistant is to take up stands (a
//! message to it, a reminder handed to it or come due for it, the owner's
//! answer, a routine's run, news of work that just failed), and each watched
//! pull request.
//!
//! A turn is read as running from its batch: `finish_turn` clears the
//! engine's turn a moment before it writes the batch, so a row may read as
//! under way a few hundred milliseconds longer than it is (R17) — what it
//! shows, never what its buttons do, which the engine checks itself.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Duration, Utc};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};

use super::activity_view::{
    AskVia, ChoiceOption, Facts, ItemCard, RowAsk, RowPr, SentMessage, Standing, WatchFacts,
};
use super::read_check::OrFailed;
use super::today::TodayView;
use crate::db::entities::personal_agent_batch::BatchStatus;
use crate::db::entities::personal_agent_dispatch::{self as dispatch_entity, DispatchState};
use crate::db::entities::personal_agent_event::{self as event_entity, EventState};
use crate::db::entities::personal_agent_item::{ItemKind, WaitsFor};
use crate::db::entities::personal_agent_message::MessageState;
use crate::db::entities::personal_agent_timeline::{self as timeline_entity, OwnerStatus};
use crate::db::entities::personal_agent_watch::WatchState;
use crate::db::service::personal_agent_service as svc;
use crate::db::AppDatabase;
use crate::models::personal_agent::ItemInfo;
use crate::models::personal_agent_prefs::{AskFirst, CiFailure, Prefs};

/// How long after a pull request failed or fell into conflict codeg is
/// taken to be about to fix it on its own (6.3 e).
const FIX_PENDING_MINUTES: i64 = 10;

/// The batches read as running, by id: read once each.
#[derive(Default)]
struct Turns {
    running: HashMap<i32, bool>,
}

impl Turns {
    async fn running(&mut self, db: &AppDatabase, batch: i32) -> bool {
        if let Some(r) = self.running.get(&batch) {
            return *r;
        }
        let r = svc::get_batch(&db.conn, batch)
            .await
            .or_failed()
            .is_some_and(|b| b.status == BatchStatus::Running);
        self.running.insert(batch, r);
        r
    }

    /// An event for `bot`, as it stands: waiting for its next turn, in a
    /// turn running now, or its turn over.
    async fn of_event(&mut self, db: &AppDatabase, bot: i32, e: &event_entity::Model) -> Standing {
        match e.state {
            // Put back after a turn that had it: taken up once already.
            EventState::Pending if e.requeues > 0 || e.requeued_from.is_some() => {
                Standing::Requeued { bot }
            }
            EventState::Pending => Standing::Queued { bot },
            EventState::Delivered => match e.batch_id {
                Some(b) if self.running(db, b).await => Standing::InTurn { bot, batch: b },
                _ => Standing::Ended,
            },
            EventState::Done => Standing::Ended,
        }
    }

    /// An owner's row for `bot`, as it stands.
    async fn of_owner_row(
        &mut self,
        db: &AppDatabase,
        bot: i32,
        r: &timeline_entity::Model,
    ) -> Standing {
        match r.status {
            Some(OwnerStatus::Queued) => Standing::Queued { bot },
            Some(OwnerStatus::Delivered | OwnerStatus::Answered) => match r.batch_id {
                Some(b) if self.running(db, b).await => Standing::InTurn { bot, batch: b },
                _ => Standing::Ended,
            },
            _ => Standing::Ended,
        }
    }
}

/// The facts for `today` and the open matters `items` (each its assistant's,
/// `item_bots`), their cards and messages as the command read them.
#[allow(clippy::too_many_arguments)]
pub async fn read(
    db: &AppDatabase,
    today: &TodayView,
    items: &[ItemInfo],
    item_bots: &HashMap<i32, i32>,
    item_cards: &HashMap<i32, ItemCard>,
    item_messages: &HashMap<i32, SentMessage>,
    prefs: &Prefs,
    now: DateTime<Utc>,
) -> Facts {
    let mut facts = Facts::default();
    let mut turns = Turns::default();
    for item in items {
        let Some(&bot) = item_bots.get(&item.id) else {
            continue;
        };
        // A message: at its receiver, by its event there (the source key
        // is unique; `delivered_batch_id` is not kept on a requeue).
        if item.kind == ItemKind::Message {
            if let Some(m) = item_messages.get(&item.id) {
                facts
                    .messages
                    .insert(item.id, message_standing(db, &mut turns, m).await);
            }
            continue;
        }
        if let Some(s) = input_standing(db, &mut turns, item, bot, item_cards.get(&item.id)).await {
            facts.inputs.insert(item.id, s);
        }
    }
    let rows = || {
        today
            .needs
            .iter()
            .chain(&today.watching)
            .chain(&today.schedule)
    };
    // Routine runs with no work of their own: by their turn.
    for r in today.watching.iter().filter(|r| r.kind == "routine_run" && r.dispatch_id.is_none()) {
        let Some(id) = r.key.strip_prefix("routine_run:").and_then(|i| i.parse::<i32>().ok()) else {
            continue;
        };
        let Some(run) = crate::db::service::personal_agent_routine_service::get_run(&db.conn, id)
            .await
            .or_failed()
        else {
            continue;
        };
        // By the event that started it, when there is one (put back after
        // a turn cut off, it waits again); else by its turn.
        let event = match run.event_id {
            Some(e) => svc::get_event_of(&db.conn, run.bot_id, e).await.or_failed(),
            None => None,
        };
        let s = match (event, run.batch_id) {
            (Some(e), _) => turns.of_event(db, run.bot_id, &e).await,
            (None, Some(b)) if turns.running(db, b).await => Standing::InTurn {
                bot: run.bot_id,
                batch: b,
            },
            (None, Some(_)) => Standing::Ended,
            (None, None) => Standing::Queued { bot: run.bot_id },
        };
        facts.routine_runs.insert(id, s);
    }
    // Work that just failed (B6): the news of it, its assistant's.
    let looking: HashSet<i32> = rows()
        .filter(|r| r.reason == Some("looking"))
        .filter_map(|r| r.dispatch_id.or(r.work_dispatch_id))
        .collect();
    for d in looking {
        let news = svc::latest_event_of_coalesce(&db.conn, &format!("dispatch:{d}"))
            .await
            .or_failed();
        if let Some(e) = news {
            if let Some(bot) = e.bot_id {
                let s = turns.of_event(db, bot, &e).await;
                facts.looking.insert(d, s);
            }
        }
    }
    // Failed work the owner saw to already (6.5) — handed to its
    // assistant from a row or its card, or being seen to: its claim on
    // this failure holds.
    let failed_work: HashSet<i32> = rows()
        .filter_map(|r| match r.kind {
            "failed" => r.dispatch_id,
            "task" if r.reason == Some("failed") => r.work_dispatch_id,
            _ => None,
        })
        .chain(items.iter().filter_map(|i| {
            let failed = matches!(
                i.dispatch_state,
                Some(DispatchState::Failed | DispatchState::Interrupted)
            );
            i.dispatch_id.filter(|_| failed)
        }))
        .collect();
    for id in failed_work {
        let Some(d) = svc::get_dispatch(&db.conn, id).await.or_failed() else {
            continue;
        };
        if !matches!(d.state, DispatchState::Failed | DispatchState::Interrupted) {
            continue;
        }
        // Its claim holds, or its result card says it was handed over (the
        // claim stale since — a restart cut its act off — the handing over
        // stands).
        if svc::failed_claim_holds(&db.conn, &svc::failed_claim_id(d.id, d.updated_at))
            .await
            .or_failed()
            || super::rules::failure_handed(db, d.id).await
        {
            facts.handed.insert(d.id);
        }
    }
    // The watched pull requests the rows are of: their own rows, and the
    // cards about them.
    let watch_ids: HashSet<i32> = rows()
        .filter_map(|r| {
            if r.kind == "pr" {
                r.key.strip_prefix("pr:").and_then(|w| w.parse().ok())
            } else {
                r.watch_id
            }
        })
        .collect();
    if watch_ids.is_empty() {
        return facts;
    }
    let fixing = fixing_rounds(db).await;
    for id in watch_ids {
        // Only a watch still watching stands for what it watches: one
        // stopped (its card still about) is not.
        let Some(w) = crate::db::service::personal_agent_watch_service::get(&db.conn, id)
            .await
            .or_failed()
            .filter(|w| w.state == WatchState::Watching)
        else {
            continue;
        };
        let fix = fixing.get(&id).copied();
        let failing = match w.phase.as_deref() {
            Some("checks_failed") => Some(super::pr_auto::Cause::Checks),
            Some("conflict") => Some(super::pr_auto::Cause::Conflict),
            _ => None,
        };
        // codeg fixes it on its own, as the owner's settings say, and has
        // rounds left: about to, a moment after it failed.
        let fix_pending = fix.is_none()
            && failing.is_some_and(|cause| {
                let mode = match cause {
                    super::pr_auto::Cause::Checks => prefs.ci_failure,
                    _ => match prefs.pr_conflict {
                        AskFirst::Auto => CiFailure::Fix,
                        AskFirst::Ask => CiFailure::Ask,
                    },
                };
                super::pr_auto::handles(&w)
                    && mode == CiFailure::Fix
                    && prefs.ci_rounds > 0
                    && super::pr_auto::auto_of(&w).fixes() < prefs.ci_rounds
                    && w
                        .last_change_at
                        .is_some_and(|at| now - at < Duration::minutes(FIX_PENDING_MINUTES))
            });
        facts.watches.insert(
            id,
            WatchFacts {
                pr: RowPr {
                    watch_id: w.id,
                    number: w.number,
                    is_mr: w.provider == "gitlab",
                    provider: w.provider.clone(),
                    url: w.url.clone(),
                    head_sha: w.head_sha.clone(),
                },
                dispatch_id: w.dispatch_id,
                task_id: w.work_task_id,
                since: w.created_at,
                phase: w.phase.clone(),
                fixing: fix,
                fix_pending,
                health: watch_health(&w, prefs, now),
            },
        );
    }
    facts
}

/// How watch `w` stands beyond its rung, against the owner's thresholds
/// (6.6).
pub(super) fn watch_health(
    w: &crate::db::entities::personal_agent_watch::Model,
    prefs: &Prefs,
    now: DateTime<Utc>,
) -> super::activity_view::WatchHealth {
    let review = w
        .detail
        .as_deref()
        .and_then(|d| serde_json::from_str::<crate::forge::ForgeChangeDetail>(d).ok())
        .and_then(|d| d.review);
    health_of(
        WatchRead {
            error_kind: w.last_error_kind.as_deref(),
            last_read_at: w.last_read_at,
            last_change_at: w.last_change_at,
            created_at: w.created_at,
            phase: w.phase.as_deref(),
            review: review.as_ref(),
        },
        prefs.pr_checks_wait_hours,
        prefs.pr_review_wait_days,
        now,
    )
}

/// What [`health_of`] reads of a watch.
struct WatchRead<'a> {
    error_kind: Option<&'a str>,
    last_read_at: Option<DateTime<Utc>>,
    last_change_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    phase: Option<&'a str>,
    review: Option<&'a crate::forge::ReviewGate>,
}

fn health_of(
    w: WatchRead<'_>,
    checks_hours: u32,
    review_days: u32,
    now: DateTime<Utc>,
) -> super::activity_view::WatchHealth {
    use super::activity_view::WatchHealth;
    let checks_wait = Duration::hours(i64::from(checks_hours.max(1)));
    // Not read: the account or the forge itself at once; a forge that does
    // not answer — or keeps refusing for its rate limit — once its last
    // good read is that old. One not found is gone after a few reads.
    if let Some(kind) = w.error_kind {
        let at_once = matches!(kind, "auth" | "no_account" | "config");
        let read_long_ago = matches!(kind, "network" | "api" | "timeout" | "rate_limited")
            && now - w.last_read_at.unwrap_or(w.created_at) > checks_wait;
        if at_once || read_long_ago {
            return WatchHealth::ReadFailed(kind.to_string());
        }
    }
    // Since its head last moved (what its checks and its review are of).
    let waited = now - w.last_change_at.unwrap_or(w.created_at);
    match w.phase {
        Some("waiting_checks") if waited > checks_wait => {
            WatchHealth::ChecksSlow(u32::try_from(waited.num_hours()).unwrap_or(u32::MAX))
        }
        Some("open") => match w.review {
            Some(r) if r.waiting() => {
                if waited > Duration::days(i64::from(review_days.max(1))) {
                    WatchHealth::ReviewSlow(u32::try_from(waited.num_days()).unwrap_or(u32::MAX))
                } else {
                    WatchHealth::ReviewPending
                }
            }
            _ => WatchHealth::Fine,
        },
        _ => WatchHealth::Fine,
    }
}

#[cfg(test)]
mod health_tests {
    use super::super::activity_view::WatchHealth;
    use super::*;

    fn read<'a>(
        kind: Option<&'a str>,
        read_hours_ago: Option<i64>,
        changed_hours_ago: i64,
        phase: &'a str,
        review: Option<&'a crate::forge::ReviewGate>,
        now: DateTime<Utc>,
    ) -> WatchRead<'a> {
        WatchRead {
            error_kind: kind,
            last_read_at: read_hours_ago.map(|h| now - Duration::hours(h)),
            last_change_at: Some(now - Duration::hours(changed_hours_ago)),
            created_at: now - Duration::days(30),
            phase: Some(phase),
            review,
        }
    }

    /// 6.6's table: each kind of read failure, when it is the owner's.
    #[test]
    fn a_watch_not_read_is_the_owners_as_its_kind_says() {
        let now = Utc::now();
        let h = |kind: &str, read: Option<i64>| {
            health_of(read_of(kind, read, now), 2, 1, now)
        };
        fn read_of(kind: &str, read: Option<i64>, now: DateTime<Utc>) -> WatchRead<'_> {
            WatchRead {
                error_kind: Some(kind),
                last_read_at: read.map(|h| now - Duration::hours(h)),
                last_change_at: None,
                created_at: now - Duration::days(30),
                phase: Some("open"),
                review: None,
            }
        }
        for kind in ["auth", "no_account", "config"] {
            assert_eq!(h(kind, Some(0)), WatchHealth::ReadFailed(kind.into()), "{kind}: at once");
        }
        for kind in ["network", "api", "timeout", "rate_limited"] {
            assert_eq!(h(kind, Some(1)), WatchHealth::Fine, "{kind}: read an hour ago");
            assert_eq!(h(kind, Some(3)), WatchHealth::ReadFailed(kind.into()), "{kind}: read long ago");
            assert_eq!(h(kind, None), WatchHealth::ReadFailed(kind.into()), "{kind}: never read");
        }
        assert_eq!(h("not_found", Some(100)), WatchHealth::Fine, "gone after a few reads, not told");
    }

    #[test]
    fn checks_and_a_review_waited_on_past_their_thresholds_are_the_owners() {
        let now = Utc::now();
        assert_eq!(health_of(read(None, Some(0), 1, "waiting_checks", None, now), 2, 1, now), WatchHealth::Fine);
        assert_eq!(
            health_of(read(None, Some(0), 5, "waiting_checks", None, now), 2, 1, now),
            WatchHealth::ChecksSlow(5)
        );
        let asked = crate::forge::ReviewGate { requested: vec!["ann".into()], ..Default::default() };
        assert_eq!(
            health_of(read(None, Some(0), 5, "open", Some(&asked), now), 2, 1, now),
            WatchHealth::ReviewPending
        );
        assert_eq!(
            health_of(read(None, Some(0), 50, "open", Some(&asked), now), 2, 1, now),
            WatchHealth::ReviewSlow(2)
        );
        let approved = crate::forge::ReviewGate { approved: true, ..Default::default() };
        assert_eq!(health_of(read(None, Some(0), 50, "open", Some(&approved), now), 2, 1, now), WatchHealth::Fine);
    }
}

/// Where a message stands at its receiver (6.2): queued for its turn, in
/// it, or its turn over without an answer.
async fn message_standing(db: &AppDatabase, turns: &mut Turns, m: &SentMessage) -> Standing {
    let to = m.to_bot;
    let key = match svc::scoped_source_key(&db.conn, to, &format!("message:{}", m.id)).await {
        Ok(k) => k,
        Err(_) => return Standing::Queued { bot: to },
    };
    let message = crate::db::service::personal_agent_message_service::get_message(&db.conn, m.id)
        .await
        .or_failed();
    let never_handed = message.as_ref().is_some_and(|msg| msg.state == MessageState::Queued);
    match svc::event_by_source_key(&db.conn, to, &key).await.or_failed() {
        // Waiting again, the message handed over before: no longer to be
        // taken back.
        Some(e) if e.state == EventState::Pending && !never_handed => {
            Standing::Requeued { bot: to }
        }
        Some(e) => turns.of_event(db, to, &e).await,
        // Not handed to it yet: queued, as the message says.
        None if never_handed => Standing::Queued { bot: to },
        None => Standing::Ended,
    }
}

/// Where the input a matter's assistant is to take up stands: a reminder
/// handed to it (by the message that handed it over), one come due for it
/// or a follow-up come due (by the event the clock raised), the owner's
/// answer to its question (by the answer). `None`: no such input.
async fn input_standing(
    db: &AppDatabase,
    turns: &mut Turns,
    item: &ItemInfo,
    bot: i32,
    card: Option<&ItemCard>,
) -> Option<Standing> {
    match item.kind {
        ItemKind::Reminder | ItemKind::Followup => {
            if let Some(c) = card.filter(|c| c.handed) {
                // The message that handed it over: named on the card, or —
                // an older card — the latest of the owner's quoting it.
                let row = match c.hand_row {
                    Some(id) => svc::get_row(&db.conn, id).await.or_failed(),
                    None => svc::latest_owner_reply_to(&db.conn, bot, c.row_id)
                        .await
                        .or_failed(),
                };
                // Sent again (its turn cut off): the copy is the one.
                let row = match row {
                    Some(r) => Some(sent_again(db, r).await),
                    None => None,
                };
                return match row {
                    Some(r) => Some(turns.of_owner_row(db, bot, &r).await),
                    None => Some(Standing::Ended),
                };
            }
            let fired = item
                .due_at
                .is_some_and(|due| item.fired_at.is_some_and(|f| f >= due));
            if fired && item.waits_for == Some(WaitsFor::Agent) {
                let e = svc::latest_event_for_item(
                    &db.conn,
                    bot,
                    super::reminders::REMINDER_EVENT,
                    item.id,
                )
                .await
                .or_failed()?;
                return Some(turns.of_event(db, bot, &e).await);
            }
            None
        }
        ItemKind::Question if item.answer_state.as_deref() == Some("linked") => {
            let r = svc::get_row(&db.conn, item.answer_row_id?).await.or_failed()?;
            Some(turns.of_owner_row(db, bot, &r).await)
        }
        _ => None,
    }
}

/// The owner's row `r` as it stands now: the copy it was sent again as
/// (`resent_as`), the latest of those, when it was.
pub(super) async fn sent_again(
    db: &AppDatabase,
    mut r: timeline_entity::Model,
) -> timeline_entity::Model {
    for _ in 0..8 {
        let copy = r
            .data
            .as_deref()
            .and_then(|d| serde_json::from_str::<serde_json::Value>(d).ok())
            .and_then(|d| d["resent_as"].as_i64())
            .and_then(|id| i32::try_from(id).ok());
        let Some(copy) = copy else {
            break;
        };
        match svc::get_row(&db.conn, copy).await.or_failed() {
            Some(next) => r = next,
            None => break,
        }
    }
    r
}

/// The rounds fixing watched pull requests now (7.4), by watch: queued or
/// running work whose `pr_fix` names it.
async fn fixing_rounds(db: &AppDatabase) -> HashMap<i32, i32> {
    let mut out = HashMap::new();
    for d in dispatch_entity::Entity::find()
        .filter(dispatch_entity::Column::PrFix.is_not_null())
        .filter(dispatch_entity::Column::State.is_in([DispatchState::Queued, DispatchState::Running]))
        .all(&db.conn)
        .await
        .or_failed()
    {
        let fix = d
            .pr_fix
            .as_deref()
            .and_then(|f| serde_json::from_str::<super::pr_auto::PrFix>(f).ok());
        if let Some(f) = fix {
            out.entry(f.watch_id).or_insert(d.id);
        }
    }
    out
}

/// What each row waiting on the owner asks, as it is answered on the row
/// itself (7.5): the assistant's own request (its timeline row), an
/// executor's forwarded to the owner (its ask card), a choice card of one
/// question; or a session's request, from its connection — work waiting in
/// its own session, a board task waiting for input, a session of the
/// owner's. A session that waits on nothing any more (its request answered
/// a moment before what the row was read from caught up) is no row. The
/// panel's alone, never kept with a brief.
pub(crate) async fn fill_asks(
    db: &AppDatabase,
    manager: &crate::acp::manager::ConnectionManager,
    today: &mut TodayView,
) {
    let mut settled: HashSet<String> = HashSet::new();
    for row in today.needs.iter_mut() {
        match ask_of(db, manager, row).await {
            AskRead::Ask(a) => row.ask = Some(a),
            AskRead::Nothing => row.ask = None,
            AskRead::Settled => {
                settled.insert(row.key.clone());
            }
        }
    }
    if !settled.is_empty() {
        today.needs.retain(|r| !settled.contains(&r.key));
    }
}

/// What a row asks, as read.
enum AskRead {
    Ask(RowAsk),
    /// Nothing answered on the row (none, or not in a word there).
    Nothing,
    /// The session it waits in waits on nothing now: answered already.
    Settled,
}

impl From<Option<RowAsk>> for AskRead {
    fn from(a: Option<RowAsk>) -> Self {
        a.map_or(AskRead::Nothing, AskRead::Ask)
    }
}

async fn ask_of(
    db: &AppDatabase,
    manager: &crate::acp::manager::ConnectionManager,
    row: &super::today::TodayRow,
) -> AskRead {
    match row.kind {
        "approval" | "question" | "forwarded" => card_ask(db, row).await.into(),
        // Handed-out work waiting in its own session: a plain permission of
        // it (its questions and plans are its ask card's, the assistant's
        // to answer first).
        "waiting" => {
            let conn = match row.dispatch_id {
                Some(id) => svc::get_dispatch(&db.conn, id)
                    .await
                    .or_failed()
                    .and_then(|d| d.connection_id),
                None => None,
            };
            match conn {
                Some(c) => session_ask(manager, &c, true).await,
                None => AskRead::Nothing,
            }
        }
        "task" if row.state.as_deref() == Some("awaiting_input") => {
            let Some(conv) = row.conversation_id else {
                return AskRead::Nothing;
            };
            match manager.find_connection_by_conversation_id(conv).await {
                // An assistant's task: its questions and plans are asks. A
                // task waits on its agents' sub-sessions too (the board
                // counts theirs): nothing on its own is no sign it is done.
                Some(c) => match session_ask(manager, &c, row.work_dispatch_id.is_some()).await {
                    AskRead::Settled => AskRead::Nothing,
                    read => read,
                },
                None => AskRead::Nothing,
            }
        }
        "session" => {
            let Some(conv) = row.conversation_id else {
                return AskRead::Nothing;
            };
            // Work an assistant still has on it: its questions and plans
            // are its ask card's (raised a moment after the request) — one
            // the owner took over, or that moved on, is theirs to answer.
            let dispatched = svc::dispatch_by_conversation(&db.conn, conv)
                .await
                .or_failed()
                .is_some_and(|d| {
                    matches!(
                        d.state,
                        DispatchState::Queued | DispatchState::Running | DispatchState::WaitingInput
                    )
                });
            match manager.find_connection_by_conversation_id(conv).await {
                Some(c) => session_ask(manager, &c, dispatched).await,
                None => AskRead::Nothing,
            }
        }
        _ => AskRead::Nothing,
    }
}

/// What a card row asks: the assistant's own request, an ask forwarded to
/// the owner, a choice of one question.
async fn card_ask(db: &AppDatabase, row: &super::today::TodayRow) -> Option<RowAsk> {
    use crate::db::entities::personal_agent_timeline::TimelineKind;
    let r = svc::get_row(&db.conn, row.row_id?).await.or_failed()?;
    let data: serde_json::Value = r
        .data
        .as_deref()
        .and_then(|d| serde_json::from_str(d).ok())
        .unwrap_or(serde_json::Value::Null);
    if let Some(card) = &row.card {
        return choice_ask(card.kind.as_str(), card.notice_id, &data);
    }
    if row.kind == "forwarded" {
        let card: super::asks::AskCard = serde_json::from_value(data).ok()?;
        if card.state != "forwarded" {
            return None;
        }
        return Some(match card.request.as_str() {
            "question" => RowAsk::Question {
                via: AskVia::Ask,
                connection_id: None,
                ask_id: Some(card.ask_id),
                question_id: card.request_id,
                questions: serde_json::to_value(&card.questions).ok()?,
            },
            _ => RowAsk::Plan {
                via: AskVia::Ask,
                connection_id: None,
                ask_id: Some(card.ask_id),
                approval_id: card.request_id,
                plan: card.plan.unwrap_or_default(),
            },
        });
    }
    if data["state"].as_str() != Some("pending") {
        return None;
    }
    let id = r.ref_id.clone()?;
    match r.kind {
        TimelineKind::Permission => Some(RowAsk::Permission {
            via: AskVia::Assistant,
            connection_id: None,
            request_id: id,
            tool_call: data["tool_call"].clone(),
            options: serde_json::from_value(data["options"].clone()).ok()?,
            queued: None,
        }),
        TimelineKind::Question if data["kind"].as_str() == Some("plan_approval") => {
            Some(RowAsk::Plan {
                via: AskVia::Assistant,
                connection_id: None,
                ask_id: None,
                approval_id: id,
                plan: r.body.clone(),
            })
        }
        TimelineKind::Question => Some(RowAsk::Question {
            via: AskVia::Assistant,
            connection_id: None,
            ask_id: None,
            question_id: id,
            questions: data["questions"].clone(),
        }),
        _ => None,
    }
}

/// A choice card's one question, its options plain (none to pick a project
/// by, no several questions): what is answered on its row.
fn choice_ask(kind: &str, notice_id: i32, data: &serde_json::Value) -> Option<RowAsk> {
    if kind != "choice"
        || data["state"].as_str() != Some("open")
        || data.get("questions").is_some_and(|q| !q.is_null())
    {
        return None;
    }
    let options = data["options"]
        .as_array()?
        .iter()
        .map(|o| {
            if o["project"].as_bool() == Some(true) {
                return None;
            }
            Some(ChoiceOption {
                key: o["key"].as_str()?.to_string(),
                label: o["label"].as_str()?.to_string(),
            })
        })
        .collect::<Option<Vec<_>>>()?;
    (!options.is_empty()).then_some(RowAsk::Choice { notice_id, options })
}

/// What connection `conn`'s session waits on the owner for now — of
/// handed-out work (`dispatched`), a plain permission only: its questions
/// and plans (a plan approval asked as a permission among them) are its
/// ask card's. Waiting on nothing: [`AskRead::Settled`]; the connection
/// gone, nothing can be told.
async fn session_ask(
    manager: &crate::acp::manager::ConnectionManager,
    conn: &str,
    dispatched: bool,
) -> AskRead {
    let Some(state) = manager.get_state(conn).await else {
        return AskRead::Nothing;
    };
    let s = state.read().await;
    if let Some(p) = s.pending_permission.as_ref() {
        if dispatched && crate::acp::types::PlanPermission::of(&p.tool_call, &p.options).is_some() {
            return AskRead::Nothing;
        }
        return AskRead::Ask(RowAsk::Permission {
            via: AskVia::Session,
            connection_id: Some(conn.to_string()),
            request_id: p.request_id.clone(),
            tool_call: p.tool_call.clone(),
            options: p.options.clone(),
            queued: (p.queued > 0).then_some(p.queued),
        });
    }
    if let Some(q) = s.pending_question.as_ref() {
        if dispatched {
            return AskRead::Nothing;
        }
        return match serde_json::to_value(&q.questions) {
            Ok(questions) => AskRead::Ask(RowAsk::Question {
                via: AskVia::Session,
                connection_id: Some(conn.to_string()),
                ask_id: None,
                question_id: q.question_id.clone(),
                questions,
            }),
            Err(_) => AskRead::Nothing,
        };
    }
    if let Some(a) = s.pending_plan_approval.as_ref() {
        if dispatched {
            return AskRead::Nothing;
        }
        return AskRead::Ask(RowAsk::Plan {
            via: AskVia::Session,
            connection_id: Some(conn.to_string()),
            ask_id: None,
            approval_id: a.approval_id.clone(),
            plan: a.plan_markdown.clone(),
        });
    }
    AskRead::Settled
}
