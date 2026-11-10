//! Each assistant's live state (8.3): computed by codeg from the database and
//! the engine — never asked of a model — and pushed to the pages as it
//! changes.
//!
//! - **Work**: busy while its brain runs a turn or work it handed out runs;
//!   idle when nothing runs but something it has is not done; done
//!   otherwise.
//! - **Attention**: needs-you while a card in its conversation waits for the
//!   owner (its brain's questions and permission requests, those shown for
//!   another, a confirmation, a step not known to have happened, a loop
//!   stopped, the opening choice, a change shown first), or handed-out work
//!   asks; unread while something it said is unseen or the owner marked it.
//! - **Activity**: the step its brain's turn is on; its brain at rest, the
//!   latest step of the work it handed out (the one first seen last).
//! - **Face**: a turn or a piece of work just done (or failed) for eight
//!   seconds; waiting while it needs the owner; thinking or working while it
//!   runs; asleep when its brain's connection is gone and nothing runs;
//!   idle otherwise.
//!
//! **Pushing.** Whatever changes an assistant's records or its sessions
//! touches it ([`EngineHost::touch`]); a touched assistant's state is pushed
//! on `personal-agent://bots` at most every 250 ms, and every 10 s while it
//! is busy, changed or not. A busy state expires 30 s after it was pushed:
//! a page that stops hearing shows it at rest, not working for ever
//! (principle 14).
//!
//! A process that does not run the assistants reads the database only: the
//! work and the attention, never the activity (`activity_known`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};

use super::activity::{line_of, line_of_call, Names};
use super::host::EngineHost;
use super::PersonalAgentEngine;
use crate::acp::session_state::LiveContentBlock;
use crate::acp::types::ConnectionStatus;
use crate::db::entities::personal_agent::{self as agent_entity, BotKind};
use crate::db::entities::personal_agent_dispatch::{DispatchMode, DispatchState};
use crate::db::entities::personal_agent_item::ItemStatus;
use crate::db::entities::personal_agent_notice::{NoticeKind, NoticeState};
use crate::db::entities::personal_agent_timeline::TimelineKind;
use crate::db::service::personal_agent_message_service as msvc;
use crate::db::service::personal_agent_service as svc;
use crate::db::AppDatabase;
use crate::models::personal_agent_roster::{
    Activity, ActivityWork, Attention, AwaitedReply, BotLive, BotsChange, FaceFlash, FaceState,
    HandWork, LastLine, NeedsYou, RosterAct, RosterFlags, StepLine, WorkState,
    PERSONAL_AGENT_BOTS_EVENT,
};
use crate::web::event_bridge::emit_event;

/// One push per assistant at most this often.
const PUSH_GAP: Duration = Duration::from_millis(250);
/// A busy assistant is pushed again this often, changed or not.
pub(super) const BUSY_REPUSH: Duration = Duration::from_secs(10);
/// A busy state not renewed for this long is stale.
const BUSY_TTL_SECS: i64 = 30;
/// A turn or a piece of work just done shows on the face this long.
const FLASH_SECS: i64 = 8;
/// Longest last line kept.
const LAST_LINE_CHARS: usize = 140;
/// First-seen times kept for the calls of handed-out sessions.
const SEEN_MAX: usize = 4096;

/// The handed-out states that count as running.
const RUNNING: &[DispatchState] = &[DispatchState::Running];
/// The handed-out states still moving.
const MOVING: &[DispatchState] = &[
    DispatchState::Queued,
    DispatchState::Running,
    DispatchState::WaitingInput,
    DispatchState::Review,
];

/// The host's record of what it pushed, and of what it watches.
pub struct LiveHub {
    inner: std::sync::Mutex<HubState>,
    /// Pushes happen (tests compute states directly instead).
    enabled: AtomicBool,
}

#[derive(Default)]
struct HubState {
    slots: HashMap<i32, Slot>,
    /// The connections of the tasks an assistant handed out, which no engine
    /// routes: their events touch it too.
    task_conns: HashMap<String, i32>,
    /// When a call (or a block) of a handed-out session was first seen.
    seen: HashMap<String, DateTime<Utc>>,
    /// Tests: pushes computed, and the most computed at once.
    #[cfg(test)]
    pub(super) test_pushes: usize,
    #[cfg(test)]
    test_in_flight: usize,
    #[cfg(test)]
    pub(super) test_max_in_flight: usize,
}

#[derive(Default)]
struct Slot {
    /// A push is scheduled (waiting out the gap).
    pending: bool,
    /// A push is being computed: a change meanwhile pushes once more after.
    running: bool,
    /// Something changed while it was computed.
    dirty: bool,
    /// When the last push went out.
    last_push: Option<Instant>,
    /// The last push said busy.
    busy: bool,
    /// A face shown for a while, and till when.
    flash: Option<(FaceState, DateTime<Utc>)>,
}

impl LiveHub {
    pub fn new(enabled: bool) -> Self {
        Self {
            inner: std::sync::Mutex::new(HubState::default()),
            enabled: AtomicBool::new(enabled),
        }
    }

    #[cfg(test)]
    pub(super) fn set_enabled(&self, on: bool) {
        self.enabled.store(on, Ordering::Relaxed);
    }

    /// Tests: nothing of `bot` scheduled, computing or changed since.
    #[cfg(test)]
    pub(super) fn test_settled(&self, bot: i32) -> bool {
        self.lock()
            .slots
            .get(&bot)
            .is_some_and(|s| !s.pending && !s.running && !s.dirty && s.last_push.is_some())
    }

    /// Tests: (pushes computed, most computed at once).
    #[cfg(test)]
    pub(super) fn test_counts(&self) -> (usize, usize) {
        let h = self.lock();
        (h.test_pushes, h.test_max_in_flight)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HubState> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Show `face` on assistant `bot` for a few seconds.
    pub(super) fn flash(&self, bot: i32, face: FaceState) {
        let until = Utc::now() + chrono::Duration::seconds(FLASH_SECS);
        self.lock().slots.entry(bot).or_default().flash = Some((face, until));
    }

    fn flash_of(&self, bot: i32) -> Option<(FaceState, DateTime<Utc>)> {
        self.lock().slots.get(&bot).and_then(|s| s.flash)
    }

    /// The assistant whose handed-out task runs on `conn`.
    pub(super) fn task_conn_owner(&self, conn: &str) -> Option<i32> {
        self.lock().task_conns.get(conn).copied()
    }

    fn watch_task_conns(&self, bot: i32, conns: Vec<String>) {
        let mut h = self.lock();
        h.task_conns.retain(|_, b| *b != bot);
        for c in conns {
            h.task_conns.insert(c, bot);
        }
    }

    fn first_seen(&self, key: String) -> DateTime<Utc> {
        let mut h = self.lock();
        if h.seen.len() >= SEEN_MAX && !h.seen.contains_key(&key) {
            h.seen.clear();
        }
        *h.seen.entry(key).or_insert_with(Utc::now)
    }

    fn busy_bots(&self) -> Vec<i32> {
        self.lock()
            .slots
            .iter()
            .filter(|(_, s)| s.busy)
            .map(|(b, _)| *b)
            .collect()
    }
}

/// What the database says of an assistant.
pub(super) struct DbFacts {
    needs: Vec<NeedsYou>,
    unread: u32,
    has_open_items: bool,
    hand: Vec<HandWork>,
    awaiting: Vec<AwaitedReply>,
    last_line: Option<LastLine>,
    last_activity_at: Option<DateTime<Utc>>,
    /// A turn of its brain is recorded as running.
    brain_running: bool,
}

/// What its engine adds: the turn, the connection, the activity.
pub(super) struct EngineFacts {
    /// The turn in flight (its batch) and the step it is on.
    turn: Option<(i32, Option<StepLine>)>,
    connected: bool,
    /// The latest step of the work it handed out.
    work_activity: Option<Activity>,
}

fn first_line(text: &str, max: usize) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .to_string();
    if line.chars().count() <= max {
        line
    } else {
        let mut cut: String = line.chars().take(max - 1).collect();
        cut.push('…');
        cut
    }
}

fn payload_of(raw: &str) -> serde_json::Value {
    serde_json::from_str(raw).unwrap_or(serde_json::Value::Null)
}

/// The cards and the work waiting on the owner, oldest first.
async fn needs_of(
    db: &AppDatabase,
    bot: i32,
    hand: &[HandWork],
    hand_since: &HashMap<i32, DateTime<Utc>>,
) -> Vec<NeedsYou> {
    let mut needs = Vec::new();
    for r in svc::pending_prompt_rows(&db.conn, bot)
        .await
        .unwrap_or_default()
    {
        let data = r.data.as_deref().map(payload_of).unwrap_or_default();
        let kind = match r.kind {
            TimelineKind::Permission => "permission",
            _ if data["kind"].as_str() == Some("plan_approval") => "plan",
            _ => "question",
        };
        needs.push(NeedsYou {
            kind: kind.into(),
            text: first_line(&r.body, LAST_LINE_CHARS),
            since: r.created_at,
            row_id: Some(r.id),
            count: 1,
        });
    }
    let open = svc::notices_in_state(&db.conn, bot, NoticeState::Open)
        .await
        .unwrap_or_default();
    let cards: Vec<_> = open
        .into_iter()
        .filter_map(|n| {
            let payload = payload_of(&n.payload);
            let suggested = payload["why"].as_str() == Some("suggest");
            let kind = match n.kind {
                NoticeKind::Proposal if !suggested => "confirm",
                NoticeKind::Changed if !suggested => "changed",
                NoticeKind::Uncertain => "uncertain",
                NoticeKind::Loop => "loop",
                NoticeKind::Choice => "choice",
                _ => return None,
            };
            Some((n, kind))
        })
        .collect();
    let row_ids: Vec<i32> = cards.iter().filter_map(|(n, _)| n.timeline_id).collect();
    let rows: HashMap<i32, String> = svc::rows_by_ids(&db.conn, bot, &row_ids)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|r| (r.id, r.body))
        .collect();
    for (n, kind) in cards {
        let text = n
            .timeline_id
            .and_then(|id| rows.get(&id))
            .map(|b| first_line(b, LAST_LINE_CHARS))
            .unwrap_or_default();
        needs.push(NeedsYou {
            kind: kind.into(),
            text,
            since: n.created_at,
            row_id: n.timeline_id,
            count: 1,
        });
    }
    for w in hand
        .iter()
        .filter(|w| w.state == DispatchState::WaitingInput)
    {
        needs.push(NeedsYou {
            kind: "input".into(),
            text: format!("#{} {}", w.dispatch_id, w.title),
            since: hand_since
                .get(&w.dispatch_id)
                .copied()
                .unwrap_or_else(Utc::now),
            row_id: None,
            count: 1,
        });
    }
    needs.sort_by_key(|n| n.since);
    needs
}

/// What the database says of assistant `row`.
pub(super) async fn db_facts(db: &AppDatabase, row: &agent_entity::Model) -> DbFacts {
    let bot = row.id;
    let dispatches = svc::list_dispatches(&db.conn, bot, MOVING, None, 50)
        .await
        .unwrap_or_default();
    let hand_since: HashMap<i32, DateTime<Utc>> =
        dispatches.iter().map(|d| (d.id, d.updated_at)).collect();
    let mut hand: Vec<HandWork> = dispatches
        .into_iter()
        .map(|d| HandWork {
            dispatch_id: d.id,
            title: d.title,
            mode: d.mode,
            state: d.state,
            work_task_id: d.work_task_id,
            conversation_id: d.conversation_id,
        })
        .collect();
    hand.reverse();
    let needs = needs_of(db, bot, &hand, &hand_since).await;
    let unread = svc::count_unseen(&db.conn, bot).await.unwrap_or(0) as u32;
    let has_open_items =
        !svc::list_items(&db.conn, bot, &[ItemStatus::Open, ItemStatus::Waiting], 1)
            .await
            .unwrap_or_default()
            .is_empty();
    let mut awaiting = Vec::new();
    let mut names: HashMap<i32, String> = HashMap::new();
    for m in msvc::live_messages_from(&db.conn, bot)
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|m| m.wants_reply)
    {
        if let std::collections::hash_map::Entry::Vacant(slot) = names.entry(m.to_bot_id) {
            let name = svc::get_bot_any(&db.conn, m.to_bot_id)
                .await
                .ok()
                .flatten()
                .map(|b| super::messages::display_name(&b))
                .unwrap_or_else(|| format!("assistant #{}", m.to_bot_id));
            slot.insert(name);
        }
        awaiting.push(AwaitedReply {
            message_id: m.id,
            to_bot_id: m.to_bot_id,
            to_name: names[&m.to_bot_id].clone(),
        });
    }
    let last_line = svc::last_said(&db.conn, bot)
        .await
        .ok()
        .flatten()
        .map(|r| LastLine {
            text: first_line(
                &crate::acp::reply_turn::display_text(&r.body),
                LAST_LINE_CHARS,
            ),
            at: r.updated_at,
        })
        .filter(|l| !l.text.is_empty());
    let last_activity_at = svc::latest_row(&db.conn, bot)
        .await
        .ok()
        .flatten()
        .map(|r| r.updated_at.max(r.created_at));
    let brain_running = !svc::running_batches(&db.conn, bot)
        .await
        .unwrap_or_default()
        .is_empty();
    DbFacts {
        needs,
        unread,
        has_open_items,
        hand,
        awaiting,
        last_line,
        last_activity_at,
        brain_running,
    }
}

/// How an assistant sits on the roster.
pub fn roster_flags(row: &agent_entity::Model) -> RosterFlags {
    RosterFlags {
        sort_order: row.sort_order,
        pinned_at: row.pinned_at,
        section: row.section.clone(),
        hidden: row.hidden,
        muted: row.muted,
        unread_mark: row.unread_mark,
        notify: row.notify,
    }
}

/// The state from the facts. `engine` is `None` in a process that does not
/// run the assistants.
pub(super) fn finish(
    row: &agent_entity::Model,
    db: DbFacts,
    engine: Option<EngineFacts>,
    flash: Option<(FaceState, DateTime<Utc>)>,
    now: DateTime<Utc>,
) -> BotLive {
    let running_work = db.hand.iter().any(|w| RUNNING.contains(&w.state));
    let turn = engine.as_ref().and_then(|e| e.turn.clone());
    let brain_busy = match &engine {
        Some(_) => turn.is_some(),
        None => db.brain_running,
    };
    let busy = brain_busy || running_work;
    let work = if busy {
        WorkState::Busy
    } else if db.has_open_items || !db.hand.is_empty() || !db.awaiting.is_empty() {
        WorkState::Idle
    } else {
        WorkState::Done
    };
    let needs = db.needs.first().cloned().map(|mut n| {
        n.count = db.needs.len() as u32;
        n
    });
    let attention = if needs.is_some() {
        Attention::NeedsYou
    } else if db.unread > 0 || row.unread_mark {
        Attention::Unread
    } else {
        Attention::None
    };
    let activity = match &turn {
        Some((batch, Some(step))) => Some(Activity {
            step: step.clone(),
            work: None,
            turn: Some(*batch),
        }),
        // Its brain at rest: what its work is doing.
        None => engine.as_ref().and_then(|e| e.work_activity.clone()),
        Some((_, None)) => None,
    };
    let flash_now = flash
        .filter(|(_, until)| *until > now)
        .map(|(face, until)| FaceFlash { face, until });
    let face = if needs.is_some() {
        FaceState::Waiting
    } else if let Some((_, step)) = &turn {
        match step {
            Some(s) if s.awaiting => FaceState::Waiting,
            None => FaceState::Thinking,
            Some(s) if s.kind == "think" => FaceState::Thinking,
            Some(_) => FaceState::Working,
        }
    } else if busy {
        FaceState::Working
    } else if engine.as_ref().is_some_and(|e| !e.connected) {
        FaceState::Sleeping
    } else {
        FaceState::Idle
    };
    BotLive {
        bot_id: row.id,
        work,
        attention,
        needs,
        unread: db.unread,
        activity,
        activity_known: engine.is_some(),
        work_on_hand: db.hand,
        awaiting: db.awaiting,
        face,
        flash: flash_now,
        connected: engine.as_ref().is_some_and(|e| e.connected),
        last_line: db.last_line,
        last_activity_at: db.last_activity_at,
        updated_at: now,
        expires_at: busy.then(|| now + chrono::Duration::seconds(BUSY_TTL_SECS)),
    }
}

/// The state as the database alone tells it: a process that does not run
/// the assistants.
pub async fn live_from_db(db: &AppDatabase, row: &agent_entity::Model) -> BotLive {
    let facts = db_facts(db, row).await;
    finish(row, facts, None, None, Utc::now())
}

/// The names steps may refer to by id.
pub(super) async fn names(db: &AppDatabase) -> Names {
    let executors = crate::db::service::assistant_service::list_all(&db.conn)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|a| (a.id, a.name))
        .collect();
    let bots = svc::list_bots(&db.conn)
        .await
        .unwrap_or_default()
        .iter()
        .map(|b| (b.id, super::messages::display_name(b)))
        .collect();
    Names { executors, bots }
}

/// The step a session is on: its last block of the main thread.
async fn session_step(
    engine: &PersonalAgentEngine,
    hub: &LiveHub,
    conn: &str,
    names: &Names,
) -> Option<(DateTime<Utc>, StepLine)> {
    let state = engine.manager.get_state(conn).await?;
    let s = state.read().await;
    let live = s.live_message.as_ref()?;
    let (i, block) = live
        .content
        .iter()
        .enumerate()
        .rev()
        .find(|(_, b)| match b {
            LiveContentBlock::Text {
                parent_tool_use_id, ..
            }
            | LiveContentBlock::Thinking {
                parent_tool_use_id, ..
            } => parent_tool_use_id.is_none(),
            _ => true,
        })?;
    let plain = |kind: &str, at: DateTime<Utc>| StepLine {
        n: i as u32,
        kind: kind.into(),
        target: None,
        status: Some("in_progress".into()),
        awaiting: false,
        started_at: at,
        added: None,
        removed: None,
        passed: None,
        failed: None,
        exit_code: None,
        hits: None,
        dispatch_id: None,
    };
    match block {
        LiveContentBlock::ToolCallRef { tool_call_id } => {
            let call = s.active_tool_calls.get(tool_call_id)?;
            let at = hub.first_seen(format!("{conn}:{tool_call_id}"));
            let mut line = line_of_call(call, at, names);
            line.n = i as u32;
            Some((at, line))
        }
        LiveContentBlock::Thinking { .. } => {
            let at = hub.first_seen(format!("{conn}:b{i}"));
            Some((at, plain("think", at)))
        }
        LiveContentBlock::Text { .. } => {
            let at = hub.first_seen(format!("{conn}:b{i}"));
            Some((at, plain("reply", at)))
        }
        LiveContentBlock::Plan { .. } => {
            let at = hub.first_seen(format!("{conn}:b{i}"));
            Some((at, plain("plan", at)))
        }
    }
}

impl PersonalAgentEngine {
    /// What this engine knows of its assistant beyond the database.
    pub(super) async fn engine_facts(
        &self,
        hub: &LiveHub,
        names: &Names,
        hand: &[HandWork],
    ) -> EngineFacts {
        let conn = self.state.lock().await.connection_id.clone();
        let connected = match conn.as_deref() {
            Some(c) => match self.manager.get_state(c).await {
                Some(state) => !matches!(
                    state.read().await.status,
                    ConnectionStatus::Disconnected | ConnectionStatus::Error
                ),
                None => false,
            },
            None => false,
        };
        let turn = match self.turn_view().await {
            Some(t) if t.compaction => Some((
                t.batch_id,
                Some(StepLine {
                    n: 0,
                    kind: "compact".into(),
                    target: None,
                    status: Some("in_progress".into()),
                    awaiting: false,
                    started_at: Utc::now(),
                    added: None,
                    removed: None,
                    passed: None,
                    failed: None,
                    exit_code: None,
                    hits: None,
                    dispatch_id: None,
                }),
            )),
            Some(t) => {
                let step = match (t.token.as_deref(), self.manager.get_state(&t.conn_id).await) {
                    (Some(token), Some(state)) => state
                        .read()
                        .await
                        .reply_turns
                        .current_step(token)
                        .map(|raw| line_of(&raw, names)),
                    _ => None,
                };
                Some((t.batch_id, step))
            }
            None => None,
        };
        // The sessions of its running work, and the tasks' connections to
        // watch.
        let by_dispatch: HashMap<i32, String> = self
            .state
            .lock()
            .await
            .dispatch_conns
            .iter()
            .map(|(conn, c)| (c.id, conn.clone()))
            .collect();
        let mut task_conns = Vec::new();
        let mut best: Option<(DateTime<Utc>, Activity)> = None;
        for w in hand.iter().filter(|w| RUNNING.contains(&w.state)) {
            let conn = match w.mode {
                DispatchMode::Task => match w.work_task_id {
                    Some(tid) => {
                        crate::db::service::work_task_service::get_model(&self.db.conn, tid)
                            .await
                            .ok()
                            .and_then(|t| t.connection_id)
                    }
                    None => None,
                },
                _ => by_dispatch.get(&w.dispatch_id).cloned(),
            };
            let Some(conn) = conn else {
                continue;
            };
            if w.mode == DispatchMode::Task {
                task_conns.push(conn.clone());
            }
            if let Some((at, step)) = session_step(self, hub, &conn, names).await {
                if best.as_ref().is_none_or(|(b, _)| at > *b) {
                    best = Some((
                        at,
                        Activity {
                            step,
                            work: Some(ActivityWork {
                                dispatch_id: w.dispatch_id,
                                title: w.title.clone(),
                            }),
                            turn: None,
                        },
                    ));
                }
            }
        }
        hub.watch_task_conns(self.bot().await, task_conns);
        EngineFacts {
            turn,
            connected,
            work_activity: best.map(|(_, a)| a),
        }
    }

    /// Show `face` on this assistant's avatar for a few seconds (a turn or a
    /// piece of work just ended), and push.
    pub(super) async fn flash_face(&self, face: FaceState) {
        if let Some(host) = self.host_ref() {
            let bot = self.bot().await;
            host.live.flash(bot, face);
            host.touch(bot);
        }
    }

    /// Something of this assistant changed: push its state soon.
    pub(super) fn touch_live(&self, bot: i32) {
        if let Some(host) = self.host_ref() {
            host.touch(bot);
        }
    }
}

impl EngineHost {
    /// The live state of assistant `bot` (not deleted), as this process —
    /// the one running it — knows it.
    pub async fn live_of(&self, row: &agent_entity::Model) -> BotLive {
        let facts = db_facts(&self.db, row).await;
        let engine = if row.kind == BotKind::Primary {
            Some(self.primary())
        } else {
            self.existing_worker(row.id).await
        };
        let engine_facts = match engine {
            Some(e) => {
                let names = names(&self.db).await;
                Some(e.engine_facts(&self.live, &names, &facts.hand).await)
            }
            // A worker with no engine yet: nothing of it runs here.
            None => Some(EngineFacts {
                turn: None,
                connected: false,
                work_activity: None,
            }),
        };
        finish(
            row,
            facts,
            engine_facts,
            self.live.flash_of(row.id),
            Utc::now(),
        )
    }

    /// Something of assistant `bot` changed: push its state, at most every
    /// [`PUSH_GAP`]. One computation at a time per assistant, in order: a
    /// change while one runs pushes once more after it, so the last push is
    /// never older than the last change, and an older state never lands
    /// after a newer one.
    pub fn touch(self: &Arc<Self>, bot: i32) {
        if bot <= 0 || !self.live.enabled.load(Ordering::Relaxed) {
            return;
        }
        {
            let mut h = self.live.lock();
            let slot = h.slots.entry(bot).or_default();
            if slot.running {
                slot.dirty = true;
                return;
            }
            if slot.pending {
                return;
            }
            slot.pending = true;
        }
        let me = self.clone();
        tokio::spawn(async move {
            loop {
                let wait = me
                    .live
                    .lock()
                    .slots
                    .get(&bot)
                    .and_then(|s| s.last_push)
                    .map(|t| PUSH_GAP.saturating_sub(t.elapsed()))
                    .unwrap_or_default();
                if !wait.is_zero() {
                    tokio::time::sleep(wait).await;
                }
                if let Some(s) = me.live.lock().slots.get_mut(&bot) {
                    s.pending = false;
                    s.running = true;
                    s.dirty = false;
                }
                #[cfg(test)]
                {
                    let mut h = me.live.lock();
                    h.test_in_flight += 1;
                    h.test_max_in_flight = h.test_max_in_flight.max(h.test_in_flight);
                }
                me.push_live(bot).await;
                #[cfg(test)]
                {
                    let mut h = me.live.lock();
                    h.test_in_flight -= 1;
                    h.test_pushes += 1;
                }
                let again = {
                    let mut h = me.live.lock();
                    let Some(s) = h.slots.get_mut(&bot) else {
                        break;
                    };
                    s.running = false;
                    if s.dirty {
                        // Waiting out the gap again: what changes meanwhile
                        // goes into that push.
                        s.dirty = false;
                        s.pending = true;
                        true
                    } else {
                        false
                    }
                };
                if !again {
                    break;
                }
            }
        });
    }

    async fn push_live(&self, bot: i32) {
        let Ok(Some(row)) = svc::get_bot(&self.db.conn, bot).await else {
            return;
        };
        let live = self.live_of(&row).await;
        let busy = live.work == WorkState::Busy;
        emit_event(
            &self.emitter,
            PERSONAL_AGENT_BOTS_EVENT,
            BotsChange::Live {
                bot_id: bot,
                live: Box::new(live),
            },
        );
        // The gap is from what went out.
        if let Some(s) = self.live.lock().slots.get_mut(&bot) {
            s.busy = busy;
            s.last_push = Some(Instant::now());
        }
    }

    /// The roster itself changed: pages read it again.
    pub fn emit_roster(&self) {
        emit_event(&self.emitter, PERSONAL_AGENT_BOTS_EVENT, BotsChange::Roster);
    }

    /// Push every busy assistant again, changed or not.
    pub(super) fn repush_busy(self: &Arc<Self>) {
        for bot in self.live.busy_bots() {
            self.touch(bot);
        }
    }
}

/// How long a group's name may be.
const SECTION_CHARS: usize = 40;

impl EngineHost {
    /// The owner arranges assistant `bot_id` on the roster (4.14). The
    /// primary stays on top: it is not pinned, grouped or hidden.
    pub async fn roster_act(self: &Arc<Self>, bot_id: i32, act: RosterAct) -> Result<(), String> {
        let row = svc::get_bot(&self.db.conn, bot_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("no assistant #{bot_id}"))?;
        let primary = row.kind == BotKind::Primary;
        let not_primary = |what: &str| -> Result<(), String> {
            if primary {
                Err(format!(
                    "the primary assistant is always on top: it cannot be {what}"
                ))
            } else {
                Ok(())
            }
        };
        let mut write = svc::RosterWrite::default();
        match act {
            RosterAct::Pin => {
                not_primary("pinned")?;
                if row.pinned_at.is_none() {
                    let last = svc::list_bots(&self.db.conn)
                        .await
                        .map_err(|e| e.to_string())?
                        .iter()
                        .filter(|b| b.pinned_at.is_some())
                        .map(|b| b.sort_order)
                        .max();
                    write.pinned_at = Some(Some(Utc::now()));
                    write.sort_order = Some(last.map_or(0, |n| n + 1));
                }
            }
            RosterAct::Unpin => write.pinned_at = Some(None),
            RosterAct::Section { name } => {
                not_primary("put in a group")?;
                let name = name
                    .map(|n| n.split_whitespace().collect::<Vec<_>>().join(" "))
                    .filter(|n| !n.is_empty())
                    .map(|n| n.chars().take(SECTION_CHARS).collect::<String>());
                write.section = Some(name);
            }
            RosterAct::Hide => {
                not_primary("hidden")?;
                write.hidden = Some(true);
            }
            RosterAct::Show => write.hidden = Some(false),
            RosterAct::Mute => write.muted = Some(true),
            RosterAct::Unmute => write.muted = Some(false),
            RosterAct::MarkUnread => write.unread_mark = Some(true),
            RosterAct::MarkRead => write.unread_mark = Some(false),
            RosterAct::Notify { on } => write.notify = Some(on),
            RosterAct::Order { ids } => {
                // The pinned ones' order, top first (the primary is never
                // among them).
                for (i, id) in ids.iter().enumerate() {
                    let Ok(Some(b)) = svc::get_bot(&self.db.conn, *id).await else {
                        continue;
                    };
                    if b.kind == BotKind::Primary {
                        continue;
                    }
                    svc::set_roster(
                        &self.db.conn,
                        *id,
                        svc::RosterWrite {
                            sort_order: Some(i as i32),
                            ..Default::default()
                        },
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                }
                self.emit_roster();
                return Ok(());
            }
        }
        svc::set_roster(&self.db.conn, bot_id, write)
            .await
            .map_err(|e| e.to_string())?;
        self.emit_roster();
        self.touch(bot_id);
        Ok(())
    }
}

impl PersonalAgentEngine {
    /// The owner settles one of its open matters from the panel: `done`,
    /// `drop`, or `later` (it waits on time). Handed-out work is settled when
    /// the work ends.
    pub async fn settle_item(
        &self,
        item_id: i32,
        act: &str,
    ) -> Result<crate::db::entities::personal_agent_item::Model, String> {
        use crate::db::entities::personal_agent_item::{ItemKind, WaitsFor};
        let bot = self.bot().await;
        let item = svc::get_item_of(&self.db.conn, bot, item_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("no matter #{item_id}"))?;
        if item.kind == ItemKind::Dispatch {
            return Err(
                "a piece of handed-out work is settled when the work ends; stop it on its card"
                    .into(),
            );
        }
        if matches!(item.status, ItemStatus::Done | ItemStatus::Dropped) {
            return Err(format!("matter #{item_id} is already settled"));
        }
        let write = match act {
            "done" => svc::ItemWrite {
                status: Some(ItemStatus::Done),
                ..Default::default()
            },
            "drop" => svc::ItemWrite {
                status: Some(ItemStatus::Dropped),
                ..Default::default()
            },
            "later" => svc::ItemWrite {
                waits_for: Some(Some(WaitsFor::Time)),
                ..Default::default()
            },
            other => return Err(format!("unknown act `{other}`")),
        };
        let updated = svc::update_item(&self.db.conn, item_id, write)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("no matter #{item_id}"))?;
        self.emit_item(item_id);
        Ok(updated)
    }
}

/// The roster as a process that does not run the assistants reads it.
pub async fn roster_from_db(db: &AppDatabase) -> Vec<(agent_entity::Model, BotLive)> {
    let mut out = Vec::new();
    for row in svc::list_bots(&db.conn).await.unwrap_or_default() {
        let live = live_from_db(db, &row).await;
        out.push((row, live));
    }
    out
}

/// The steps the brain of assistant `bot` (`None`: the primary) went
/// through in the turn in flight, as short lines; none when it runs no
/// turn here.
pub async fn turn_steps(db: &AppDatabase, bot: Option<i32>) -> Vec<StepLine> {
    let Some(engine) = super::engine::engine_for(bot).await else {
        return Vec::new();
    };
    let Some(turn) = engine.turn_view().await else {
        return Vec::new();
    };
    let Some(token) = turn.token else {
        return Vec::new();
    };
    let Some(state) = engine.manager.get_state(&turn.conn_id).await else {
        return Vec::new();
    };
    let raws = state.read().await.reply_turns.steps(&token);
    let names = names(db).await;
    raws.iter().map(|r| line_of(r, &names)).collect()
}
