//! "Today" (6.3): the owner's day in four groups, every assistant's at once —
//! what waits on them anywhere in codeg, what the assistants keep an eye on,
//! what is set for the rest of the day, and what was done today, the things
//! the assistants did for the owner among it (which they can take back).
//!
//! All of it is read from codeg's own records and live state, never from a
//! model. "Waits on the owner" is the `overview` tool's list (8.1) — each
//! assistant's cards and asks, its handed-out work that failed lately, the
//! board's tasks that wait on them, every other session waiting for an
//! answer, each once — with the assistants' suggestions and the reminders
//! that came due today. A question an assistant is answering is not the
//! owner's until it is forwarded to them (7.3.1).
//!
//! The day is the owner's: from [`DAY_BREAK_HOUR`]:00 to [`DAY_BREAK_HOUR`]:00
//! in their zone, as their usual hours are counted (1.12).

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Duration, Utc};
use chrono_tz::Tz;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
use serde::Serialize;
use serde_json::Value;

use super::clock;
use super::due;
use super::live::db_facts;
use super::overview::{
    board, conversations, owners_session, task_needs_owner, task_running, Folders, Provenance,
    FAILED_FRESH_DAYS,
};
use super::presence::{hours_day, DAY_BREAK_HOUR};
use super::reach::need_kind;
use crate::acp::manager::ConnectionManager;
use crate::db::entities::personal_agent_dispatch::{
    self as dispatch_entity, DispatchMode, DispatchState,
};
use crate::db::entities::personal_agent_item::{self as item_entity, ItemStatus};
use crate::db::entities::personal_agent_notice::{self as notice_entity, NoticeKind, NoticeState};
use crate::db::entities::work_task::WorkTaskStatus;
use crate::db::service::personal_agent_service as svc;
use crate::db::AppDatabase;
use crate::models::personal_agent_prefs::{AccountView, Level, Prefs};

/// The longest a row's text is.
const TEXT_MAX: usize = 200;

/// The four groups, each newest-relevant first as the page shows them.
#[derive(Debug, Clone, Default, Serialize)]
pub struct TodayView {
    /// Waits on the owner: urgent first, then normal, then low; the longest
    /// waiting first within each.
    pub needs: Vec<TodayRow>,
    /// Handed-out work and board tasks running, the latest first.
    pub watching: Vec<TodayRow>,
    /// What is set for the rest of the day, by time.
    pub schedule: Vec<TodayRow>,
    /// Ended today, the latest first.
    pub done: Vec<TodayRow>,
    /// The owner's day: when it began and when it ends.
    pub day_start: DateTime<Utc>,
    pub day_end: DateTime<Utc>,
    pub at: DateTime<Utc>,
    /// The handed-out work rows point at (`dispatch_id`), for the page to
    /// open as it opens a work card. Filled by the page call.
    pub dispatches: Vec<crate::models::personal_agent::DispatchInfo>,
    /// The morning brief or the wrap-up being prepared (6.4).
    pub brief: Option<super::brief::TodayBrief>,
}

/// One row: what it is, whose it is, and what opens it.
#[derive(Debug, Clone, Serialize)]
pub struct TodayRow {
    /// The same thing keeps the same key across reads.
    pub key: String,
    /// What the row is:
    /// - waits on the owner — an assistant's card or ask, as its news is
    ///   named (`approval`, `forwarded`, `question`, `confirm`, `stuck`,
    ///   `waiting`: its handed-out work waits in its own session), an
    ///   assistant's `proposal`, handed-out work that `failed`, a board
    ///   `task`, a `session`, a `reminder` that came due;
    /// - watching — handed-out work (`dispatch`), a board `task`, a watched
    ///   pull request (`pr`, its state its rung);
    /// - the schedule — a matter (`item`);
    /// - done — handed-out work `finished`, a question `answered` for the
    ///   owner, a setting `changed` for them, a pull request merged
    ///   (`pr_merged`).
    /// - the schedule also has a `routine` that runs later today; watching,
    ///   a `routine_run` under way; done, a routine's report
    ///   (`routine_report`, its state `reported` or `silent`).
    pub kind: &'static str,
    /// How urgent a wait is, by the owner's levels (6.2).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<Level>,
    /// The assistant it is about; `None`: the owner's own session or task.
    pub bot_id: Option<i32>,
    /// The project it is in (shown for the owner's own).
    pub project: Option<TodayProject>,
    /// A name for it: a card's text, a task's or a session's title.
    pub title: String,
    /// A second line: what a session asks, why a task failed, the answer.
    pub text: Option<String>,
    /// When it began waiting, is due, ended.
    pub at: DateTime<Utc>,
    /// A word on its state: a task's status, a dispatch's state, what a
    /// session waits for (`permission`, `question`, `plan`), a matter's kind
    /// (`reminder`, `followup`, …) and what it does when due (`:notify`,
    /// `:act`), a changed card's `acted` or `undone`.
    pub state: Option<String>,
    /// The assistant's timeline row to scroll to.
    pub row_id: Option<i32>,
    pub dispatch_id: Option<i32>,
    pub task_id: Option<i32>,
    pub conversation_id: Option<i32>,
    pub item_id: Option<i32>,
    pub notice_id: Option<i32>,
    /// The routine it is, or is a run of (6.9).
    pub routine_id: Option<i32>,
    /// The agent a session runs.
    pub agent_type: Option<String>,
    /// The owner can take it back here ([Undo]).
    pub undo: bool,
    /// A setting `changed` for the owner: its card's `changes` and the
    /// `names` they use, for the page to word it as the card does — its
    /// title is codeg's plain line, a setting by its key.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changes: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TodayProject {
    pub id: i32,
    pub name: String,
}

impl TodayRow {
    pub(super) fn new(key: String, kind: &'static str, title: String, at: DateTime<Utc>) -> Self {
        Self {
            key,
            kind,
            level: None,
            bot_id: None,
            project: None,
            title,
            text: None,
            at,
            state: None,
            row_id: None,
            dispatch_id: None,
            task_id: None,
            conversation_id: None,
            item_id: None,
            notice_id: None,
            routine_id: None,
            agent_type: None,
            undo: false,
            changes: None,
        }
    }
}

/// A changed card's changes and the names they use, from its row's data;
/// `None` when it lists none.
fn changes_of(data: Option<&str>) -> Option<Value> {
    let data: Value = serde_json::from_str(data?).ok()?;
    let changes = data.get("changes")?;
    if changes.as_array().is_none_or(|a| a.is_empty()) {
        return None;
    }
    Some(serde_json::json!({
        "changes": changes,
        "names": data.get("names").cloned().unwrap_or(Value::Null),
    }))
}

/// The first line of `text` with something in it, at most [`TEXT_MAX`].
fn one_line(text: &str) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    if line.chars().count() <= TEXT_MAX {
        line.to_string()
    } else {
        let mut cut: String = line.chars().take(TEXT_MAX - 1).collect();
        cut.push('…');
        cut
    }
}

fn some_line(text: &str) -> Option<String> {
    Some(one_line(text)).filter(|l| !l.is_empty())
}

/// The owner's day around `now`: from [`DAY_BREAK_HOUR`]:00 of the day they
/// are in to the same hour of the next.
pub fn day_of(now: DateTime<Utc>, tz: Tz) -> (DateTime<Utc>, DateTime<Utc>) {
    let day = hours_day(now, tz);
    let start = day.and_hms_opt(DAY_BREAK_HOUR, 0, 0).expect("a valid hour");
    let end = (day + Duration::days(1))
        .and_hms_opt(DAY_BREAK_HOUR, 0, 0)
        .expect("a valid hour");
    (due::local_at(tz, start), due::local_at(tz, end))
}

/// Urgent first, then normal, then low.
fn level_rank(l: Option<Level>) -> u8 {
    match l {
        Some(Level::Urgent) => 0,
        Some(Level::Normal) | None => 1,
        Some(Level::Low) => 2,
    }
}

/// A card's row on its timeline.
async fn card_row_of(
    db: &AppDatabase,
    n: &notice_entity::Model,
) -> Option<crate::db::entities::personal_agent_timeline::Model> {
    svc::get_row(&db.conn, n.timeline_id?).await.ok().flatten()
}

/// A tidy-up's or a process skill's card as "today" lists it (7.7, 7.8):
/// its words, how it stands now, and whether it can still be undone.
fn row_of_card(
    kind: &'static str,
    bot: i32,
    n: &notice_entity::Model,
    card: &crate::db::entities::personal_agent_timeline::Model,
) -> TodayRow {
    let data = card.data.as_deref().map(payload_of).unwrap_or(Value::Null);
    let at = n.acted_at.unwrap_or(n.updated_at);
    let mut row = TodayRow::new(format!("{kind}:{}", n.id), kind, one_line(&card.body), at);
    row.bot_id = Some(bot);
    row.state = data["state"].as_str().map(str::to_string);
    row.row_id = Some(card.id);
    row.notice_id = Some(n.id);
    row.undo = n.state == NoticeState::Acted;
    row
}

fn payload_of(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap_or(Value::Null)
}

/// The owner's account preferences: the primary's settings.
async fn account_prefs(db: &AppDatabase) -> Prefs {
    match svc::primary_bot(&db.conn).await.ok().flatten() {
        Some(p) => AccountView::from_settings(&p.settings).prefs,
        None => Prefs::default(),
    }
}

/// Today as it stands at `now`.
pub async fn today(
    db: &AppDatabase,
    manager: &ConnectionManager,
    now: DateTime<Utc>,
) -> (TodayView, Vec<dispatch_entity::Model>) {
    today_from(db, manager, now, None).await
}

/// [`today`], with what was done counted from `done_from` rather than the
/// day's start: the morning brief's "since the last one" (6.4).
pub async fn today_from(
    db: &AppDatabase,
    manager: &ConnectionManager,
    now: DateTime<Utc>,
    done_from: Option<DateTime<Utc>>,
) -> (TodayView, Vec<dispatch_entity::Model>) {
    let prefs = account_prefs(db).await;
    let tz = clock::zone_of(&prefs.time_zone);
    let (day_start, day_end) = day_of(now, tz);
    let done_from = done_from.unwrap_or(day_start);
    let bots = svc::list_bots(&db.conn).await.unwrap_or_default();
    let folders = Folders::load(db).await;
    let tasks = board(db, None).await;
    let glances = manager.session_glances().await;
    let conv_ids: Vec<i32> = glances.iter().filter_map(|g| g.conversation_id).collect();
    let convs = conversations(db, &conv_ids).await;
    let task_dispatches: Vec<i32> = tasks
        .iter()
        .filter_map(|t| t.personal_agent_dispatch_id)
        .collect();
    let prov = Provenance::load(db, &task_dispatches, &conv_ids).await;
    let project_of = |folder_id: i32| {
        folders
            .project(folder_id)
            .map(|(id, name)| TodayProject { id, name })
    };

    let mut view = TodayView {
        day_start,
        day_end,
        at: now,
        ..TodayView::default()
    };
    // The handed-out work rows point at.
    let mut dispatch_ids: Vec<i32> = Vec::new();
    // Dispatches already standing in a row that waits on the owner.
    let mut waiting_dispatches: HashSet<i32> = HashSet::new();

    // ── waits on the owner ──────────────────────────────────────────────
    // A dispatch with an ask open (its assistant answering, or forwarded):
    // its session and its task are its ask's, not listed again.
    let mut asking: HashSet<i32> = super::asks::asked_dispatches(db).await;
    for bot in &bots {
        let facts = db_facts(db, bot).await;
        // A request shown where its work began is the asker's: listed there.
        for n in facts.needs.iter().filter(|n| !n.mirror) {
            let Some(kind) = need_kind(n) else {
                continue;
            };
            let mut row = TodayRow::new(
                match (n.row_id, n.dispatch_id) {
                    (Some(r), _) => format!("card:{}:{r}", bot.id),
                    (None, Some(d)) => format!("waiting:{}:{d}", bot.id),
                    (None, None) => format!("need:{}:{}", bot.id, n.since.timestamp_millis()),
                },
                kind,
                one_line(&n.text),
                n.since,
            );
            row.level = Some(prefs.level_of(kind));
            row.bot_id = Some(bot.id);
            row.row_id = n.row_id;
            row.state = Some(n.kind.clone());
            if let Some(d) = n.dispatch_id {
                asking.insert(d);
                waiting_dispatches.insert(d);
                // Work waiting in its own session is named by its title; a
                // forwarded ask by what it asks, its work under it.
                if let Some(w) = facts.hand.iter().find(|w| w.dispatch_id == d) {
                    if kind == "waiting" {
                        row.title = one_line(&w.title);
                    } else {
                        row.text = some_line(&w.title);
                    }
                    row.task_id = w.work_task_id;
                    row.conversation_id = w.conversation_id;
                }
                row.dispatch_id = Some(d);
                dispatch_ids.push(d);
            }
            view.needs.push(row);
        }
    }
    // What the assistants suggest: a card that changes nothing until the
    // owner says so (low).
    for n in notice_entity::Entity::find()
        .filter(notice_entity::Column::State.eq(NoticeState::Open))
        .filter(notice_entity::Column::Kind.is_in([
            NoticeKind::Proposal,
            NoticeKind::Changed,
            NoticeKind::Forge,
            NoticeKind::Routine,
            NoticeKind::Rule,
        ]))
        .order_by_asc(notice_entity::Column::Id)
        .all(&db.conn)
        .await
        .unwrap_or_default()
    {
        let payload = payload_of(&n.payload);
        // One of codeg's proposal rules (6.7): the ones whose thing no
        // other row stands for (failed work, a task, a session have theirs).
        if n.kind == NoticeKind::Rule {
            let rule = payload["rule"].as_str().unwrap_or("");
            if !matches!(rule, "pr_review" | "uncommitted" | "idle" | "new_project") {
                continue;
            }
            let Some(bot) = n.bot_id.filter(|b| bots.iter().any(|x| x.id == *b)) else {
                continue;
            };
            let facts = &payload["facts"];
            let title = ["title", "name", "summary", "project"]
                .iter()
                .find_map(|k| facts[*k].as_str())
                .map(one_line)
                .unwrap_or_default();
            let mut row = TodayRow::new(format!("rule:{}", n.id), "rule", title, n.created_at);
            row.level = Some(match n.level {
                crate::db::entities::personal_agent_notice::NoticeLevel::Urgent => Level::Urgent,
                crate::db::entities::personal_agent_notice::NoticeLevel::Normal => Level::Normal,
                crate::db::entities::personal_agent_notice::NoticeLevel::Low => Level::Low,
            });
            row.bot_id = Some(bot);
            row.row_id = n.timeline_id;
            row.notice_id = Some(n.id);
            row.state = Some(rule.to_string());
            row.text = match rule {
                "pr_review" => facts["number"]
                    .as_i64()
                    .map(|num| format!("{} #{num}", facts["project"].as_str().unwrap_or(""))),
                "uncommitted" | "new_project" => facts["path"].as_str().map(one_line),
                _ => None,
            };
            view.needs.push(row);
            continue;
        }
        // A forge action keeps its call whole (7.4).
        let why = payload["why"].as_str().or(payload["call"]["why"].as_str());
        // The assistant's own suggestion of a dispatch, a follow-up or a
        // message (6.7) has its topic so.
        let suggested = n.kind == NoticeKind::Proposal
            && n.subject_key.as_deref().is_some_and(|k| k.starts_with("suggest:"));
        if why != Some("suggest") && !suggested {
            continue;
        }
        let Some(bot) = n.bot_id.filter(|b| bots.iter().any(|x| x.id == *b)) else {
            continue;
        };
        let title = match n.timeline_id {
            Some(id) => svc::get_row(&db.conn, id)
                .await
                .ok()
                .flatten()
                .map(|r| one_line(&r.body))
                .unwrap_or_default(),
            None => String::new(),
        };
        let mut row = TodayRow::new(
            format!("proposal:{}", n.id),
            "proposal",
            title,
            n.created_at,
        );
        row.level = Some(Level::Low);
        row.bot_id = Some(bot);
        row.row_id = n.timeline_id;
        row.notice_id = Some(n.id);
        view.needs.push(row);
    }
    // A tidy-up or a process skill kept as a draft for the owner to look
    // at (7.7, 7.8): theirs to apply or let go.
    for n in notice_entity::Entity::find()
        .filter(notice_entity::Column::State.eq(NoticeState::Open))
        .filter(notice_entity::Column::Kind.is_in([NoticeKind::Tidy, NoticeKind::Skill]))
        .order_by_asc(notice_entity::Column::Id)
        .all(&db.conn)
        .await
        .unwrap_or_default()
    {
        let Some(bot) = n.bot_id.filter(|b| bots.iter().any(|x| x.id == *b)) else {
            continue;
        };
        let Some(card) = card_row_of(db, &n).await else {
            continue;
        };
        let name = if n.kind == NoticeKind::Tidy {
            "tidy"
        } else {
            "skill"
        };
        let mut row = row_of_card(name, bot, &n, &card);
        row.level = Some(Level::Low);
        view.needs.push(row);
    }
    // Handed-out work that failed lately, outside the board.
    for bot in &bots {
        for d in svc::list_dispatches(
            &db.conn,
            bot.id,
            &[DispatchState::Failed, DispatchState::Interrupted],
            None,
            20,
        )
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|d| {
            d.mode != DispatchMode::Task && d.updated_at > now - Duration::days(FAILED_FRESH_DAYS)
        }) {
            let mut row = TodayRow::new(
                format!("failed:{}", d.id),
                "failed",
                one_line(&d.title),
                d.updated_at,
            );
            row.level = Some(prefs.level_of("done"));
            row.bot_id = Some(bot.id);
            row.text = d.error.as_deref().and_then(some_line);
            row.state = Some(super::engine::enum_str(&d.state));
            row.dispatch_id = Some(d.id);
            row.conversation_id = d.conversation_id;
            dispatch_ids.push(d.id);
            view.needs.push(row);
        }
    }
    // The board's tasks that wait on the owner, as the sidebar badge counts
    // them. A dispatched one asking for input asks through its assistant's
    // card above; one asking for input asks through its session: its row
    // stands for both.
    let mut listed_conversations: HashSet<i32> = HashSet::new();
    // A task its assistant is accepting is its assistant's — or the owner's
    // through its acceptance card (7.5): not the board's review row.
    let accepting = super::acceptance::being_accepted(db, &tasks).await;
    for t in tasks.iter().filter(|t| task_needs_owner(t)) {
        if accepting.contains_key(&t.id) {
            continue;
        }
        if t.status == WorkTaskStatus::AwaitingInput {
            listed_conversations.extend(t.conversation_id);
            if t.personal_agent_dispatch_id
                .is_some_and(|d| asking.contains(&d))
            {
                continue;
            }
        }
        let mut row = TodayRow::new(
            format!("task:{}", t.id),
            "task",
            one_line(&t.title),
            t.updated_at,
        );
        row.level = Some(match t.status {
            WorkTaskStatus::AwaitingInput => prefs.level_of("waiting"),
            _ => prefs.level_of("done"),
        });
        row.bot_id = prov.bot_of(t.personal_agent_dispatch_id);
        row.project = project_of(t.folder_id);
        row.text = (t.status == WorkTaskStatus::Failed)
            .then(|| t.last_error.as_deref().and_then(some_line))
            .flatten();
        row.state = Some(super::engine::enum_str(&t.status));
        row.task_id = Some(t.id);
        row.conversation_id = t.conversation_id;
        if let Some(d) = t.personal_agent_dispatch_id {
            waiting_dispatches.insert(d);
        }
        view.needs.push(row);
    }
    // Every other session waiting for an answer: the owner's own, and
    // handed-out work's whose ask is not listed above (one the owner took
    // over, one whose work moved on).
    for g in glances
        .iter()
        .filter(|g| g.wait.is_some() && owners_session(g, &convs))
    {
        let (Some(w), Some(c)) = (&g.wait, g.conversation_id.and_then(|c| convs.get(&c))) else {
            continue;
        };
        let dispatch = prov.by_conversation.get(&c.id).copied();
        if dispatch.is_some_and(|d| asking.contains(&d)) || listed_conversations.contains(&c.id) {
            continue;
        }
        let title = c
            .title
            .as_deref()
            .and_then(some_line)
            .unwrap_or_else(|| format!("#{}", c.id));
        let mut row = TodayRow::new(format!("session:{}", c.id), "session", title, w.since);
        row.level = Some(prefs.level_of("waiting"));
        row.bot_id = prov.bot_of(dispatch);
        row.project = project_of(c.folder_id);
        row.text = some_line(&w.text);
        row.state = Some(w.kind.to_string());
        row.conversation_id = Some(c.id);
        row.agent_type = Some(c.agent_type.clone());
        view.needs.push(row);
    }
    // Reminders that came due today and wait on the owner, with their cards.
    let reminder_cards: HashMap<i32, (i32, Option<i32>)> = notice_entity::Entity::find()
        .filter(notice_entity::Column::State.eq(NoticeState::Open))
        .filter(notice_entity::Column::Kind.eq(NoticeKind::Reminder))
        .all(&db.conn)
        .await
        .unwrap_or_default()
        .into_iter()
        .filter_map(|n| {
            let item = payload_of(&n.payload)["item_id"]
                .as_i64()
                .and_then(|v| i32::try_from(v).ok())?;
            Some((item, (n.id, n.timeline_id)))
        })
        .collect();
    let items = item_entity::Entity::find()
        .filter(item_entity::Column::Status.is_in([ItemStatus::Open, ItemStatus::Waiting]))
        .filter(item_entity::Column::DueAt.gte(day_start))
        .filter(item_entity::Column::DueAt.lt(day_end))
        .order_by_asc(item_entity::Column::DueAt)
        .all(&db.conn)
        .await
        .unwrap_or_default();
    for i in &items {
        let (Some(due_at), Some(bot)) = (i.due_at, i.bot_id) else {
            continue;
        };
        if !bots.iter().any(|b| b.id == bot) {
            continue;
        }
        let fired = i.fired_at.is_some_and(|f| f >= due_at);
        let at_due = due::AtDue::parse(i.at_due.as_deref());
        if fired {
            // A reminder waits on the owner while its card is open; a matter
            // the assistant does woke it, and is its own from then.
            let Some((notice, card)) = reminder_cards.get(&i.id).copied() else {
                continue;
            };
            let mut row = TodayRow::new(
                format!("reminder:{}", i.id),
                "reminder",
                one_line(&i.summary),
                due_at,
            );
            row.level = Some(prefs.level_of("reminder"));
            row.bot_id = Some(bot);
            row.row_id = card;
            row.item_id = Some(i.id);
            row.notice_id = Some(notice);
            view.needs.push(row);
        } else {
            // Still to come (or the clock takes it within a tick).
            let mut row = TodayRow::new(
                format!("item:{}", i.id),
                "item",
                one_line(&i.summary),
                due_at,
            );
            row.bot_id = Some(bot);
            row.row_id = i.origin_timeline_id;
            row.item_id = Some(i.id);
            row.state = Some(format!(
                "{}:{}",
                super::engine::enum_str(&i.kind),
                at_due.map(|a| a.as_str()).unwrap_or("notify")
            ));
            view.schedule.push(row);
        }
    }
    // The routines that run in the rest of the day (6.9).
    let routines = crate::db::service::personal_agent_routine_service::list_all(&db.conn)
        .await
        .unwrap_or_default();
    let routine_titles: HashMap<i32, String> =
        routines.iter().map(|r| (r.id, r.title.clone())).collect();
    for r in &routines {
        if !r.enabled
            || r.trigger != crate::db::entities::personal_agent_routine::RoutineTrigger::Schedule
            || !bots.iter().any(|b| b.id == r.bot_id)
        {
            continue;
        }
        let Some(next) = r.next_run_at.filter(|t| *t >= now && *t < day_end) else {
            continue;
        };
        let mut row = TodayRow::new(
            format!("routine:{}:{}", r.id, next.timestamp()),
            "routine",
            one_line(&r.title),
            next,
        );
        row.bot_id = Some(r.bot_id);
        row.state = Some(super::engine::enum_str(&r.kind));
        row.routine_id = Some(r.id);
        view.schedule.push(row);
    }
    view.schedule.sort_by_key(|r| r.at);
    // Within a level, what is in a project the owner worked in lately (or
    // in none) before what is in one they left or asked codeg not to mind;
    // then the longest waiting first (5.2).
    let recent = super::profile::recent_projects(db, &folders, now).await;
    view.needs.sort_by_key(|r| {
        let aside = r.project.as_ref().is_some_and(|p| !recent.contains(&p.id));
        (level_rank(r.level), aside, r.at)
    });

    // ── watching ────────────────────────────────────────────────────────
    // Handed-out work moving outside the board — a task is the board's row
    // — one whose question its assistant is answering among it.
    let bot_ids: HashSet<i32> = bots.iter().map(|b| b.id).collect();
    for d in dispatch_entity::Entity::find()
        .filter(dispatch_entity::Column::State.is_in([
            DispatchState::Queued,
            DispatchState::Running,
            DispatchState::WaitingInput,
        ]))
        .filter(dispatch_entity::Column::Mode.ne(DispatchMode::Task))
        .order_by_desc(dispatch_entity::Column::Id)
        .all(&db.conn)
        .await
        .unwrap_or_default()
    {
        let Some(bot) = d.bot_id.filter(|b| bot_ids.contains(b)) else {
            continue;
        };
        if waiting_dispatches.contains(&d.id) {
            continue;
        }
        let mut row = TodayRow::new(
            format!("dispatch:{}", d.id),
            "dispatch",
            one_line(&d.title),
            d.created_at,
        );
        row.bot_id = Some(bot);
        row.state = Some(super::engine::enum_str(&d.state));
        row.dispatch_id = Some(d.id);
        row.conversation_id = d.conversation_id;
        dispatch_ids.push(d.id);
        view.watching.push(row);
    }
    for t in tasks.iter().filter(|t| {
        task_running(t)
            || accepting
                .get(&t.id)
                .is_some_and(|v| *v == super::acceptance::AcceptView::Checking)
    }) {
        let mut row = TodayRow::new(
            format!("task:{}", t.id),
            "task",
            one_line(&t.title),
            t.started_at.unwrap_or(t.updated_at),
        );
        row.bot_id = prov.bot_of(t.personal_agent_dispatch_id);
        row.project = project_of(t.folder_id);
        row.state = Some(if accepting.contains_key(&t.id) {
            "checking".to_string()
        } else {
            super::engine::enum_str(&t.status)
        });
        row.task_id = Some(t.id);
        row.conversation_id = t.conversation_id;
        view.watching.push(row);
    }
    // The pull requests the assistants watch (7.4): one ready to merge
    // waits on the owner (its card, above).
    for w in crate::db::service::personal_agent_watch_service::watching(&db.conn, None)
        .await
        .unwrap_or_default()
    {
        if !bot_ids.contains(&w.bot_id) || w.kind != "pr" || w.phase.as_deref() == Some("mergeable")
        {
            continue;
        }
        let label = format!(
            "{}{}{}",
            w.owner_repo,
            if w.provider == "gitlab" { "!" } else { "#" },
            w.number
        );
        let mut row = TodayRow::new(
            format!("pr:{}", w.id),
            "pr",
            w.title
                .as_deref()
                .map(one_line)
                .unwrap_or_else(|| label.clone()),
            w.last_change_at.unwrap_or(w.created_at),
        );
        row.bot_id = Some(w.bot_id);
        row.project = w.folder_id.and_then(project_of);
        row.text = Some(label);
        row.state = Some(w.phase.clone().unwrap_or_else(|| "open".into()));
        row.task_id = w.work_task_id;
        if let Some(d) = w.dispatch_id {
            row.dispatch_id = Some(d);
            dispatch_ids.push(d);
        }
        view.watching.push(row);
    }
    // Routine runs under way: its assistant on it, the work it handed out,
    // or the owner's confirmation it waits for (6.9).
    for run in crate::db::service::personal_agent_routine_service::running_runs(&db.conn)
        .await
        .unwrap_or_default()
    {
        let Some(title) = routine_titles.get(&run.routine_id) else {
            continue;
        };
        if !bot_ids.contains(&run.bot_id) {
            continue;
        }
        let mut row = TodayRow::new(
            format!("routine_run:{}", run.id),
            "routine_run",
            one_line(title),
            run.started_at,
        );
        row.bot_id = Some(run.bot_id);
        row.state = Some(super::engine::enum_str(&run.outcome));
        row.routine_id = Some(run.routine_id);
        if let Some(d) = run.dispatch_id {
            row.dispatch_id = Some(d);
            dispatch_ids.push(d);
        }
        view.watching.push(row);
    }
    view.watching.sort_by_key(|r| std::cmp::Reverse(r.at));

    // ── done today ──────────────────────────────────────────────────────
    for d in dispatch_entity::Entity::find()
        .filter(
            dispatch_entity::Column::State
                .is_in([DispatchState::Completed, DispatchState::Canceled]),
        )
        .filter(dispatch_entity::Column::FinishedAt.gte(done_from))
        .order_by_desc(dispatch_entity::Column::FinishedAt)
        .all(&db.conn)
        .await
        .unwrap_or_default()
    {
        let Some(bot) = d.bot_id.filter(|b| bot_ids.contains(b)) else {
            continue;
        };
        let mut row = TodayRow::new(
            format!("finished:{}", d.id),
            "finished",
            one_line(&d.title),
            d.finished_at.unwrap_or(d.updated_at),
        );
        row.bot_id = Some(bot);
        row.text = d.result_excerpt.as_deref().and_then(some_line);
        row.state = Some(super::engine::enum_str(&d.state));
        row.dispatch_id = Some(d.id);
        row.task_id = d.work_task_id;
        row.conversation_id = d.conversation_id;
        dispatch_ids.push(d.id);
        view.done.push(row);
    }
    // Pull requests merged today, as their watches read it (7.4).
    for w in crate::db::service::personal_agent_watch_service::ended_since(&db.conn, done_from)
        .await
        .unwrap_or_default()
    {
        if !bot_ids.contains(&w.bot_id) || w.ended_reason.as_deref() != Some("merged") {
            continue;
        }
        let label = format!(
            "{}{}{}",
            w.owner_repo,
            if w.provider == "gitlab" { "!" } else { "#" },
            w.number
        );
        let mut row = TodayRow::new(
            format!("pr_merged:{}", w.id),
            "pr_merged",
            w.title
                .as_deref()
                .map(one_line)
                .unwrap_or_else(|| label.clone()),
            w.last_change_at.unwrap_or(w.updated_at),
        );
        row.bot_id = Some(w.bot_id);
        row.project = w.folder_id.and_then(project_of);
        row.text = Some(label);
        row.state = Some("merged".into());
        row.task_id = w.work_task_id;
        if let Some(d) = w.dispatch_id {
            row.dispatch_id = Some(d);
            dispatch_ids.push(d);
        }
        view.done.push(row);
    }
    for a in super::asks::answered_for_owner_since(db, done_from).await {
        if !bot_ids.contains(&a.bot_id) {
            continue;
        }
        let mut row = TodayRow::new(
            format!("answered:{}", a.ask_id),
            "answered",
            one_line(&a.asked),
            a.answered_at,
        );
        row.bot_id = Some(a.bot_id);
        row.text = a.answer.as_deref().and_then(some_line);
        row.state = Some(a.request);
        row.row_id = a.row_id;
        row.dispatch_id = Some(a.dispatch_id);
        view.done.push(row);
    }
    // Settings and assistants an assistant changed for the owner today.
    for n in svc::notices_since(
        &db.conn,
        NoticeKind::Changed,
        &[NoticeState::Acted, NoticeState::Undone],
        done_from,
    )
    .await
    .unwrap_or_default()
    {
        let payload = payload_of(&n.payload);
        // A work assistant's change as the primary records it is the same
        // change, listed once where it was made; a suggestion is here once
        // the owner took it.
        if payload["why"].as_str() == Some("line") {
            continue;
        }
        let Some(bot) = n.bot_id.filter(|b| bot_ids.contains(b)) else {
            continue;
        };
        // Changed today, or changed before and taken back today.
        let at = n.acted_at.unwrap_or(n.updated_at);
        if at < done_from && n.state != NoticeState::Undone {
            continue;
        }
        let card = match n.timeline_id {
            Some(id) => svc::get_row(&db.conn, id).await.ok().flatten(),
            None => None,
        };
        let title = card.as_ref().map(|r| one_line(&r.body)).unwrap_or_default();
        let mut row = TodayRow::new(format!("changed:{}", n.id), "changed", title, at);
        row.changes = card.as_ref().and_then(|r| changes_of(r.data.as_deref()));
        row.bot_id = Some(bot);
        row.state = Some(if n.state == NoticeState::Undone {
            "undone".into()
        } else {
            "acted".into()
        });
        row.row_id = n.timeline_id;
        row.notice_id = Some(n.id);
        row.undo = n.state == NoticeState::Acted;
        view.done.push(row);
    }
    // What the assistants remembered today (7.7): low, each with its undo.
    for n in svc::notices_since(
        &db.conn,
        NoticeKind::Memory,
        &[NoticeState::Acted, NoticeState::Undone],
        done_from,
    )
    .await
    .unwrap_or_default()
    {
        let Some(bot) = n.bot_id.filter(|b| bot_ids.contains(b)) else {
            continue;
        };
        // Remembered today, or remembered before and taken back today.
        if n.created_at < done_from && n.state != NoticeState::Undone {
            continue;
        }
        let title = match n.timeline_id {
            Some(id) => svc::get_row(&db.conn, id)
                .await
                .ok()
                .flatten()
                .map(|r| one_line(&r.body))
                .unwrap_or_default(),
            None => String::new(),
        };
        let at = n.acted_at.unwrap_or(n.updated_at);
        let mut row = TodayRow::new(format!("memory:{}", n.id), "memory", title, at);
        row.bot_id = Some(bot);
        row.state = Some(if n.state == NoticeState::Undone {
            "undone".into()
        } else {
            "acted".into()
        });
        row.row_id = n.timeline_id;
        row.notice_id = Some(n.id);
        row.undo = n.state == NoticeState::Acted;
        view.done.push(row);
    }
    // Their nightly tidy-ups and process skills (7.7, 7.8): low, each with
    // its undo while it stands. A draft waits on the owner (in "needs").
    for (kind, name) in [(NoticeKind::Tidy, "tidy"), (NoticeKind::Skill, "skill")] {
        for n in svc::notices_since(
            &db.conn,
            kind,
            &[
                NoticeState::Acted,
                NoticeState::Undone,
                NoticeState::Dismissed,
                NoticeState::Expired,
            ],
            done_from,
        )
        .await
        .unwrap_or_default()
        {
            let Some(bot) = n.bot_id.filter(|b| bot_ids.contains(b)) else {
                continue;
            };
            if n.created_at < done_from && n.state != NoticeState::Undone {
                continue;
            }
            let Some(row) = card_row_of(db, &n).await else {
                continue;
            };
            view.done.push(row_of_card(name, bot, &n, &row));
        }
    }
    // What the assistants did on a forge for the owner today (7.4).
    for n in svc::notices_since(
        &db.conn,
        NoticeKind::Forge,
        &[NoticeState::Acted],
        done_from,
    )
    .await
    .unwrap_or_default()
    {
        let Some(bot) = n.bot_id.filter(|b| bot_ids.contains(b)) else {
            continue;
        };
        let at = n.acted_at.unwrap_or(n.updated_at);
        if at < done_from {
            continue;
        }
        let title = match n.timeline_id {
            Some(id) => svc::get_row(&db.conn, id)
                .await
                .ok()
                .flatten()
                .map(|r| one_line(&r.body))
                .unwrap_or_default(),
            None => String::new(),
        };
        let mut row = TodayRow::new(format!("forge:{}", n.id), "forge", title, at);
        row.bot_id = Some(bot);
        row.state = Some("acted".into());
        row.row_id = n.timeline_id;
        row.notice_id = Some(n.id);
        view.done.push(row);
    }
    // The routines' reports today, "no change" among them (6.2: low).
    for run in crate::db::service::personal_agent_routine_service::runs_between(
        &db.conn, done_from, day_end,
    )
    .await
    .unwrap_or_default()
    {
        use crate::db::entities::personal_agent_routine_run::RunOutcome;
        if !matches!(run.outcome, RunOutcome::Reported | RunOutcome::Silent) {
            continue;
        }
        let Some(title) = routine_titles.get(&run.routine_id) else {
            continue;
        };
        if !bot_ids.contains(&run.bot_id) {
            continue;
        }
        let mut row = TodayRow::new(
            format!("routine_report:{}", run.id),
            "routine_report",
            one_line(title),
            run.ended_at.unwrap_or(run.started_at),
        );
        row.bot_id = Some(run.bot_id);
        row.state = Some(super::engine::enum_str(&run.outcome));
        row.routine_id = Some(run.routine_id);
        row.text = run.note.as_deref().and_then(some_line);
        if let Some(b) = run.batch_id {
            row.row_id = svc::reply_row_of_batch(&db.conn, b)
                .await
                .ok()
                .flatten()
                .filter(|r| !svc::is_discarded(r))
                .map(|r| r.id);
        }
        if let Some(d) = run.dispatch_id {
            row.dispatch_id = Some(d);
            dispatch_ids.push(d);
        }
        view.done.push(row);
    }
    view.done.sort_by_key(|r| std::cmp::Reverse(r.at));

    view.brief = super::brief::today_note(db, now).await;

    dispatch_ids.sort_unstable();
    dispatch_ids.dedup();
    let dispatches = if dispatch_ids.is_empty() {
        Vec::new()
    } else {
        dispatch_entity::Entity::find()
            .filter(dispatch_entity::Column::Id.is_in(dispatch_ids))
            .all(&db.conn)
            .await
            .unwrap_or_default()
    };
    (view, dispatches)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn the_day_runs_from_four_to_four_in_the_owners_zone() {
        let tz: Tz = "Asia/Shanghai".parse().unwrap();
        // 10:00 in Shanghai.
        let now = Utc.with_ymd_and_hms(2026, 11, 11, 2, 0, 0).unwrap();
        let (start, end) = day_of(now, tz);
        assert_eq!(start, Utc.with_ymd_and_hms(2026, 11, 10, 20, 0, 0).unwrap());
        assert_eq!(end, Utc.with_ymd_and_hms(2026, 11, 11, 20, 0, 0).unwrap());
        // 02:00 in Shanghai is still the day before.
        let late = Utc.with_ymd_and_hms(2026, 11, 10, 18, 0, 0).unwrap();
        assert_eq!(
            day_of(late, tz).0,
            Utc.with_ymd_and_hms(2026, 11, 9, 20, 0, 0).unwrap()
        );
    }

    #[test]
    fn a_line_is_the_first_with_something_in_it_and_not_too_long() {
        assert_eq!(one_line("\n  \n Hello \nworld"), "Hello");
        let long = "x".repeat(TEXT_MAX + 5);
        assert_eq!(one_line(&long).chars().count(), TEXT_MAX);
        assert!(one_line(&long).ends_with('…'));
        assert_eq!(some_line("  "), None);
    }
}
