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

use super::read_check::OrFailed;
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
use crate::db::entities::personal_agent::Model as AgentModel;
use crate::db::entities::personal_agent_item::{self as item_entity, ItemStatus, WaitsFor};
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
    /// The timeline rows of acceptance cards still open that nothing can be
    /// done on any more (C1): a later round took over, the run moved on, the
    /// task left review (merging, say). Not listed; the page does not lead
    /// the owner to them either.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub stale_acceptance: Vec<i32>,
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
    /// - done — handed-out work `finished` (a check of a message the owner
    ///   asked about `checked`; a check under acceptance is its work's), a
    ///   question `answered` for the
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
    /// What a board task or failed work waits on the owner for, in a word
    /// the page puts into a sentence and a button: read off the round of
    /// acceptance as it stands and what the board can do now — see
    /// [`task_reason`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
    /// A setting `changed` for the owner: its card's `changes` and the
    /// `names` they use, for the page to word it as the card does — its
    /// title is codeg's plain line, a setting by its key.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changes: Option<Value>,
    /// A board task being checked (C1): the check's own work, and its round.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub check_dispatch_id: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub round: Option<i32>,
    /// The acceptance it waits on the owner for, its task queued to merge
    /// meanwhile (C1): said after its state.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub queued: bool,
    /// A matter settled today (`matter_closed`): who settled it (`owner`,
    /// `agent`, `codeg`) and how (`done`, `dropped`, `withdrawn`, ...).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closed_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closed_how: Option<String>,
    /// ... a message's: the assistant it waited on (`{ id, name, avatar,
    /// gone }`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peer: Option<Value>,
    /// ... what takes the owner's act on the panel back while it still can
    /// be (`personal_agent_item_undo`); a card's [Undo] is `undo`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matter_undo: Option<i32>,
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
            reason: None,
            changes: None,
            check_dispatch_id: None,
            round: None,
            queued: false,
            closed_by: None,
            closed_how: None,
            peer: None,
            matter_undo: None,
        }
    }
}

/// The assistant a message's matter waits on, as its sender's line keeps
/// it: by its name now, or — deleted — the one it had.
pub(crate) async fn item_peer(db: &AppDatabase, i: &item_entity::Model) -> Option<Value> {
    if i.kind != item_entity::ItemKind::Message {
        return None;
    }
    let line = svc::get_row(&db.conn, i.origin_timeline_id?).await.ok().flatten()?;
    let data = line
        .data
        .as_deref()
        .and_then(|d| serde_json::from_str::<Value>(d).ok())?;
    let id = data["to_bot_id"].as_i64().and_then(|v| i32::try_from(v).ok())?;
    let snapshot = &data["peer"];
    let bot = svc::get_bot_any(&db.conn, id).await.ok().flatten();
    let avatar = |b: &AgentModel| serde_json::from_str::<Value>(&b.avatar).unwrap_or(Value::Null);
    Some(match bot {
        Some(b) => serde_json::json!({
            "id": id,
            "name": b.name,
            "avatar": avatar(&b),
            "gone": b.deleted_at.is_some(),
        }),
        None => serde_json::json!({
            "id": id,
            "name": snapshot["name"],
            "avatar": snapshot["avatar"],
            "gone": true,
        }),
    })
}

/// The matters of `bots` settled since `from` (§3.7): who settled each and
/// how, the latest first — not handed-out work (its own rows say it), nor
/// one the assistant wrote settled from the start. An act of the owner's on
/// the panel that can still be taken back carries what takes it back.
pub async fn closed_matters(
    db: &AppDatabase,
    bots: &[i32],
    from: DateTime<Utc>,
    now: DateTime<Utc>,
) -> Vec<TodayRow> {
    use crate::db::entities::personal_agent_item::ItemKind;
    use crate::db::entities::personal_agent_message as message_entity;
    use crate::db::entities::personal_agent_timeline as timeline_entity;
    let items = item_entity::Entity::find()
        .filter(item_entity::Column::BotId.is_in(bots.to_vec()))
        .filter(item_entity::Column::ClosedAt.gte(from))
        .filter(item_entity::Column::Kind.ne(ItemKind::Dispatch))
        .filter(item_entity::Column::Status.is_in([ItemStatus::Done, ItemStatus::Dropped]))
        .order_by_desc(item_entity::Column::ClosedAt)
        .all(&db.conn)
        .await
        .or_failed();
    let mut out = Vec::new();
    for i in items {
        let Some(closed_at) = i.closed_at else {
            continue;
        };
        let born_dropped = i.closed_by.as_deref() == Some("agent")
            && i.closed_how.as_deref() == Some("dropped")
            && closed_at == i.created_at;
        if born_dropped {
            continue;
        }
        let mut row = TodayRow::new(
            format!("matter_closed:{}", i.id),
            "matter_closed",
            one_line(&i.summary),
            closed_at,
        );
        row.bot_id = i.bot_id;
        row.item_id = Some(i.id);
        row.state = Some(super::engine::enum_str(&i.kind));
        row.closed_by = i.closed_by.clone();
        row.closed_how = i.closed_how.clone();
        row.peer = item_peer(db, &i).await;
        // Where it goes: an answered question to the answer, a message
        // answered to the answer, the rest to where it came from.
        row.row_id = match (i.kind, i.closed_how.as_deref()) {
            (ItemKind::Question, Some("answered")) => i.answer_row_id.or(i.origin_timeline_id),
            (ItemKind::Message, Some("replied")) => {
                let mut to = i.origin_timeline_id;
                if let Some(line) = match i.origin_timeline_id {
                    Some(id) => svc::get_row(&db.conn, id).await.ok().flatten(),
                    None => None,
                } {
                    let sent = line
                        .ref_id
                        .as_deref()
                        .and_then(|r| r.strip_prefix('m'))
                        .and_then(|m| m.parse::<i32>().ok());
                    if let Some(sent) = sent {
                        let reply = message_entity::Entity::find()
                            .filter(message_entity::Column::ReplyTo.eq(sent))
                            .order_by_desc(message_entity::Column::Id)
                            .one(&db.conn)
                            .await
                            .ok()
                            .flatten();
                        if let Some(reply) = reply {
                            let at = timeline_entity::Entity::find()
                                .filter(timeline_entity::Column::BotId.eq(i.bot_id))
                                .filter(timeline_entity::Column::RefId.eq(format!("m{}", reply.id)))
                                .one(&db.conn)
                                .await
                                .ok()
                                .flatten();
                            to = at.map(|r| r.id).or(to);
                        }
                    }
                }
                to
            }
            _ => i.origin_timeline_id,
        };
        if i.closed_by.as_deref() == Some("owner") {
            row.matter_undo =
                crate::db::service::personal_agent_matter_service::item_undo_token(&db.conn, &i, now)
                    .await
                    .ok()
                    .flatten();
        }
        out.push(row);
    }
    out
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

/// What a board task waiting on the owner waits for (B2), from the latest
/// round of its acceptance (`latest`, its state as stored — a round counts
/// only for the run it was for) and what the board can do now:
/// - `failed` — it failed;
/// - `accepted_queued` / `merge_queued` — in the board's merge queue
///   (accepted first or not: the owner can queue a merge themselves);
/// - `accepted_unchecked` — accepted without its check verifying it;
/// - `needs_delivery` — accepted, and its work goes back to the pull
///   request it came from (the board will not merge it locally);
/// - `merge_ready` — accepted, to merge;
/// - `review` — in review with no acceptance: the owner's to review;
/// - `looking` (set where the row is made) — it just failed, and its
///   assistant has a moment to pick it up first (B6);
/// - `None` — awaiting input, or nothing to merge (the board offers to
///   complete it): its row's own words.
///
/// `worktree_gone`: its worktree's folder or directory is gone, as the board
/// reads it (`annotate_worktree_missing`).
pub(crate) fn task_reason(
    t: &crate::db::entities::work_task::Model,
    latest: Option<&crate::db::entities::personal_agent_verification::Model>,
    worktree_gone: bool,
) -> Option<&'static str> {
    use crate::db::entities::personal_agent_verification::VerificationState;
    match t.status {
        WorkTaskStatus::Failed => return Some("failed"),
        WorkTaskStatus::Review => {}
        _ => return None,
    }
    let accepted = latest.filter(|r| r.state == VerificationState::Accepted && r.run_seq == t.run_seq);
    if crate::db::service::work_task_service::queued_merge(t.pending_merge.as_deref()).is_some() {
        return Some(if accepted.is_some() {
            "accepted_queued"
        } else {
            "merge_queued"
        });
    }
    if t.files_changed == Some(0) || t.worktree_folder_id.is_none() || worktree_gone {
        return None;
    }
    Some(match accepted {
        Some(r) if r.unchecked => "accepted_unchecked",
        Some(_) if t.source_kind.as_deref() == Some("forge_pr") => "needs_delivery",
        Some(_) => "merge_ready",
        None => "review",
    })
}

/// Whether the assistants run in this process (B6): their host is here. A
/// test's engines run where the test does.
fn assistants_run_here() -> bool {
    cfg!(test) || super::host::host().is_some()
}

/// Whether something that failed at `at` failed just now (B6): within
/// [`super::dispatch::FAILED_HOLD_SECS`] of `now`.
fn just_failed(at: DateTime<Utc>, now: DateTime<Utc>) -> bool {
    now - at < Duration::seconds(super::dispatch::FAILED_HOLD_SECS) && at <= now
}

/// Whether a task's recorded worktree can no longer serve a merge: its
/// folder row is removed, or its directory is gone from disk — as the board
/// reads it, offering "complete" instead.
pub(crate) async fn worktree_gone(
    db: &AppDatabase,
    t: &crate::db::entities::work_task::Model,
) -> bool {
    if t.status != WorkTaskStatus::Review {
        return false;
    }
    let Some(id) = t.worktree_folder_id else {
        return true;
    };
    let live = crate::db::entities::folder::Entity::find_by_id(id)
        .filter(crate::db::entities::folder::Column::DeletedAt.is_null())
        .one(&db.conn)
        .await;
    match live {
        Ok(Some(f)) => !std::path::Path::new(&f.path).exists(),
        Ok(None) => true,
        // Unread: the merge stays the safe default, as on the board.
        Err(e) => {
            super::read_check::note(e.to_string());
            false
        }
    }
}

/// A card's row on its timeline.
async fn card_row_of(
    db: &AppDatabase,
    n: &notice_entity::Model,
) -> Option<crate::db::entities::personal_agent_timeline::Model> {
    svc::get_row(&db.conn, n.timeline_id?).await.or_failed()
}

/// The card the latest firing of a matter's reminder raised (C1): its
/// notice — the newest on the matter's subject whose time is the matter's
/// due time now, written with it in one go — and its row on the timeline.
pub(crate) async fn reminder_card(
    db: &AppDatabase,
    item: &item_entity::Model,
) -> Option<(notice_entity::Model, crate::db::entities::personal_agent_timeline::Model)> {
    let due_at = item.due_at?;
    let notices = notice_entity::Entity::find()
        .filter(notice_entity::Column::Kind.eq(NoticeKind::Reminder))
        .filter(notice_entity::Column::SubjectKey.eq(svc::reminder_subject(item.id)))
        .order_by_desc(notice_entity::Column::Id)
        .all(&db.conn)
        .await
        .or_failed();
    let n = notices.into_iter().find(|n| {
        payload_of(&n.payload)["due_at"]
            .as_str()
            .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
            .is_some_and(|t| t.with_timezone(&Utc) == due_at)
    })?;
    let card = card_row_of(db, &n).await?;
    Some((n, card))
}

/// One row for a piece of work (C1), in "needs you": an acceptance card the
/// owner can still act on stands for its task — the board's review row of
/// the same task goes into it, its time the earliest of them, and a merge
/// queued meanwhile is said on it (`queued`). One they cannot act on any
/// more (a later round, the run moved on under an ask, the task out of
/// review) is not listed: its task is as the board has it now.
///
/// Can be acted on: the latest round of its work, its task in review, and —
/// for an ask, decided against the run it was for — that run still the
/// task's; one to check again (void, changed) is checked against the
/// worktree as it is, whatever run it was for.
async fn represent(
    db: &AppDatabase,
    prefs: &Prefs,
    bots: &[AgentModel],
    view: &mut TodayView,
    tasks: &[crate::db::entities::work_task::Model],
    queued: &mut Vec<TodayRow>,
) -> HashSet<i32> {
    use crate::db::entities::personal_agent_verification::VerificationState as V;
    use crate::db::service::personal_agent_verification_service as vsvc;
    let cards: HashMap<i32, notice_entity::Model> = notice_entity::Entity::find()
        .filter(notice_entity::Column::State.eq(NoticeState::Open))
        .filter(notice_entity::Column::Kind.eq(NoticeKind::Acceptance))
        .all(&db.conn)
        .await
        .or_failed()
        .into_iter()
        .filter_map(|n| Some((n.timeline_id?, n)))
        .collect();
    let int = |v: &Value| v.as_i64().and_then(|n| i32::try_from(n).ok());
    let works: Vec<i32> = cards
        .values()
        .filter_map(|n| int(&payload_of(&n.payload)["dispatch_id"]))
        .collect();
    let latest = vsvc::latest_of(&db.conn, &works).await.or_failed();
    let mut stood_for: HashMap<i32, usize> = HashMap::new();
    let mut kept = Vec::with_capacity(view.needs.len());
    let mut needs = std::mem::take(&mut view.needs);
    // An open card with no row of its own (raised after its assistant's
    // needs were read, say): its row, from the card.
    let listed: HashSet<i32> = needs
        .iter()
        .filter(|r| r.kind == "acceptance")
        .filter_map(|r| r.row_id)
        .collect();
    let mut missing: Vec<&notice_entity::Model> = cards
        .iter()
        .filter(|(row, n)| !listed.contains(row) && n.bot_id.is_some_and(|b| bots.iter().any(|x| x.id == b)))
        .map(|(_, n)| n)
        .collect();
    missing.sort_by_key(|n| n.id);
    for n in missing {
        let (Some(bot), Some(card)) = (n.bot_id, card_row_of(db, n).await) else {
            continue;
        };
        let mut row = TodayRow::new(
            format!("card:{bot}:{}", card.id),
            "acceptance",
            one_line(&card.body),
            card.created_at,
        );
        row.level = Some(prefs.level_of("acceptance"));
        row.bot_id = Some(bot);
        row.row_id = Some(card.id);
        row.state = Some("acceptance".into());
        needs.push(row);
    }
    for mut row in needs {
        let card = (row.kind == "acceptance")
            .then(|| row.row_id.and_then(|r| cards.get(&r)))
            .flatten();
        let Some(card) = card else {
            kept.push(row);
            continue;
        };
        let payload = payload_of(&card.payload);
        let work = int(&payload["dispatch_id"]);
        let round = int(&payload["round_id"]);
        let task = int(&payload["work_task_id"]).and_then(|id| tasks.iter().find(|t| t.id == id));
        let r = work.and_then(|w| latest.get(&w)).filter(|r| Some(r.id) == round);
        let live = match (r, task) {
            (Some(r), Some(t)) if t.status == WorkTaskStatus::Review => match r.state {
                V::Asked => r.run_seq == t.run_seq,
                V::Void | V::Changed => true,
                _ => false,
            },
            _ => false,
        };
        let Some(t) = task.filter(|_| live) else {
            view.stale_acceptance.extend(row.row_id);
            continue;
        };
        row.dispatch_id = work;
        row.task_id = Some(t.id);
        row.queued =
            crate::db::service::work_task_service::queued_merge(t.pending_merge.as_deref()).is_some();
        stood_for.insert(t.id, kept.len());
        kept.push(row);
    }
    // The board's own rows of those tasks go into their acceptance's: its
    // time the earliest, so what waited long still reads so.
    let board_row = |r: &TodayRow| {
        (r.kind == "task")
            .then_some(r.task_id)
            .flatten()
            .and_then(|t| stood_for.get(&t).copied())
    };
    let earliest: Vec<(usize, DateTime<Utc>)> = kept
        .iter()
        .chain(queued.iter())
        .filter_map(|r| board_row(r).map(|at| (at, r.at)))
        .collect();
    for (at, t) in earliest {
        kept[at].at = kept[at].at.min(t);
    }
    kept.retain(|r| board_row(r).is_none());
    queued.retain(|r| board_row(r).is_none());
    view.needs = kept;
    stood_for.into_keys().collect()
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
    match svc::primary_bot(&db.conn).await.or_failed() {
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
    let bots = svc::list_bots(&db.conn).await.or_failed();
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
        .or_failed()
    {
        let payload = payload_of(&n.payload);
        // One of codeg's proposal rules (6.7): the ones whose thing no
        // other row stands for (failed work, a task, a session have theirs).
        if n.kind == NoticeKind::Rule {
            let rule = payload["rule"].as_str().unwrap_or("");
            if !matches!(rule, "pr_review" | "uncommitted" | "idle") {
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
                "uncommitted" => facts["path"].as_str().map(one_line),
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
                .or_failed()
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
        .or_failed()
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
    // Failures just now, their assistants' to pick up first (B6): watched
    // — only where the assistants run, in this process; driven elsewhere,
    // nothing here knows it will be picked up.
    let mut held: Vec<TodayRow> = Vec::new();
    let holds = assistants_run_here();
    // Handed-out work that failed lately: outside the board, and a task's
    // the board shows no failure for — its start failed before the task
    // took it up (still to do), or there is no task at all (B1). One the
    // owner set aside or archived on the board is as they left it; one
    // other work took over is that work's.
    for bot in &bots {
        for d in svc::list_dispatches(
            &db.conn,
            bot.id,
            &[DispatchState::Failed, DispatchState::Interrupted],
            None,
            20,
        )
        .await
        .or_failed()
        .into_iter()
        .filter(|d| d.updated_at > now - Duration::days(FAILED_FRESH_DAYS))
        {
            if super::dispatch::superseded(db, &d).await {
                continue;
            }
            if d.mode == DispatchMode::Task {
                if let Some(tid) = d.work_task_id {
                    let shown = tasks
                        .iter()
                        .any(|t| t.id == tid && t.status == WorkTaskStatus::Failed && task_needs_owner(t));
                    if shown {
                        continue;
                    }
                    let left = super::read_check::found(
                        crate::db::service::work_task_service::get_model(&db.conn, tid).await,
                    )
                    .is_some_and(|t| t.deferred_at.is_some() || t.archived_at.is_some());
                    if left {
                        continue;
                    }
                }
            }
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
            row.reason = Some("failed");
            row.dispatch_id = Some(d.id);
            row.conversation_id = d.conversation_id;
            // Its result card, for one that never opened a session to go to.
            row.row_id = svc::latest_result_row(&db.conn, d.id)
                .await
                .or_failed()
                .map(|r| r.id);
            dispatch_ids.push(d.id);
            // Just failed: its assistant, woken by it, has a moment to pick
            // it up first — watched until then (B6).
            if holds
                && d.state == DispatchState::Failed
                && just_failed(d.finished_at.unwrap_or(d.updated_at), now)
            {
                row.reason = Some("looking");
                row.level = None;
                held.push(row);
                continue;
            }
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
    // The latest round of acceptance of each task in review: what it waits
    // on the owner for (B2).
    let reviewed: Vec<i32> = tasks
        .iter()
        .filter(|t| t.status == WorkTaskStatus::Review)
        .filter_map(|t| t.personal_agent_dispatch_id)
        .collect();
    let rounds = crate::db::service::personal_agent_verification_service::latest_of(
        &db.conn, &reviewed,
    )
    .await
    .or_failed();
    // Queued to merge: nothing left for the owner to do — watched, not
    // waiting on them.
    let mut queued: Vec<TodayRow> = Vec::new();
    for t in tasks.iter().filter(|t| task_needs_owner(t)) {
        if accepting.contains_key(&t.id) {
            continue;
        }
        // Its failed run taken over by other work (B1): that work's row.
        if matches!(t.status, WorkTaskStatus::Failed | WorkTaskStatus::Canceled) {
            if let Some(d) = t.personal_agent_dispatch_id {
                if let Some(d) = svc::get_dispatch(&db.conn, d).await.or_failed() {
                    if super::dispatch::superseded(db, &d).await {
                        continue;
                    }
                }
            }
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
        row.reason = task_reason(
            t,
            t.personal_agent_dispatch_id.and_then(|d| rounds.get(&d)),
            worktree_gone(db, t).await,
        );
        if let Some(d) = t.personal_agent_dispatch_id {
            waiting_dispatches.insert(d);
        }
        if matches!(row.reason, Some("accepted_queued" | "merge_queued")) {
            row.level = None;
            row.at = t.updated_at;
            queued.push(row);
            continue;
        }
        // An assistant's task that just failed (not an interruption, which
        // codeg retries its own way): its assistant's moment first (B6).
        if holds
            && t.status == WorkTaskStatus::Failed
            && t.failure_reason.as_deref() != Some("interrupted")
            && row.bot_id.is_some()
            && just_failed(t.settled_at.unwrap_or(t.updated_at), now)
        {
            row.reason = Some("looking");
            row.level = None;
            held.push(row);
            continue;
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
    let items = item_entity::Entity::find()
        .filter(item_entity::Column::Status.is_in([ItemStatus::Open, ItemStatus::Waiting]))
        .filter(item_entity::Column::DueAt.gte(day_start))
        .filter(item_entity::Column::DueAt.lt(day_end))
        .order_by_asc(item_entity::Column::DueAt)
        .all(&db.conn)
        .await
        .or_failed();
    let mut reminders_handed: Vec<TodayRow> = Vec::new();
    for i in &items {
        let (Some(due_at), Some(bot)) = (i.due_at, i.bot_id) else {
            continue;
        };
        if !bots.iter().any(|b| b.id == bot) {
            continue;
        }
        // Fired, and still waiting on this firing: on the owner, or handed
        // to its assistant. Put off since (later, no set time), it goes by
        // the matter, its card's moment over.
        let fired = i.fired_at.is_some_and(|f| f >= due_at)
            && matches!(i.waits_for, Some(WaitsFor::Owner | WaitsFor::Agent));
        let at_due = due::AtDue::parse(i.at_due.as_deref());
        if fired {
            // A reminder stands as the card this firing raised does (C1):
            // open, it waits on the owner; handed to its assistant, it is
            // watched — between the two writes of a hand-over too, when the
            // matter still says it waits on the owner. A matter the
            // assistant does woke it, and is its own from then.
            let Some((notice, card)) = reminder_card(db, i).await else {
                continue;
            };
            let card_state = card
                .data
                .as_deref()
                .map(payload_of)
                .and_then(|d| d["state"].as_str().map(str::to_string));
            let handed = card_state.as_deref() == Some("handed");
            if !handed && (notice.state != NoticeState::Open || card_state.as_deref() != Some("open")) {
                continue;
            }
            let mut row = TodayRow::new(
                format!("reminder:{}", i.id),
                "reminder",
                one_line(&i.summary),
                due_at,
            );
            row.bot_id = Some(bot);
            row.row_id = Some(card.id);
            row.item_id = Some(i.id);
            row.notice_id = Some(notice.id);
            if handed {
                row.state = Some("handed".into());
                reminders_handed.push(row);
            } else {
                row.level = Some(prefs.level_of("reminder"));
                view.needs.push(row);
            }
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
        .or_failed();
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
    // One row for a piece of work (C1): an acceptance the owner can still
    // act on stands for its task; one they cannot is not listed.
    let represented = represent(db, &prefs, &bots, &mut view, &tasks, &mut queued).await;
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
        .or_failed()
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
            || (accepting
                .get(&t.id)
                .is_some_and(|v| *v == super::acceptance::AcceptView::Checking)
                // Its acceptance card waits on the owner and stands for it.
                && !represented.contains(&t.id))
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
        // Queued to merge while it is being checked (the owner can queue
        // one): said so.
        if crate::db::service::work_task_service::queued_merge(t.pending_merge.as_deref()).is_some()
        {
            row.reason = task_reason(
                t,
                t.personal_agent_dispatch_id.and_then(|d| rounds.get(&d)),
                false,
            );
        }
        row.task_id = Some(t.id);
        row.conversation_id = t.conversation_id;
        // Its check under way (C1): the check's own work stands in it.
        if let Some(r) = t
            .personal_agent_dispatch_id
            .and_then(|d| rounds.get(&d))
            .filter(|r| {
                r.run_seq == t.run_seq
                    && r.state
                        == crate::db::entities::personal_agent_verification::VerificationState::Checking
            })
        {
            row.check_dispatch_id = r.check_dispatch_id;
            row.round = Some(r.round);
        }
        view.watching.push(row);
    }
    view.watching.extend(queued);
    view.watching.extend(held);
    view.watching.extend(reminders_handed);
    // A check whose task's row stands for it is not a row of its own.
    let checks: HashSet<i32> = view
        .watching
        .iter()
        .filter_map(|r| r.check_dispatch_id)
        .collect();
    view.watching
        .retain(|r| !(r.kind == "dispatch" && r.dispatch_id.is_some_and(|d| checks.contains(&d))));

    // The pull requests the assistants watch (7.4): one ready to merge
    // waits on the owner (its card, above).
    for w in crate::db::service::personal_agent_watch_service::watching(&db.conn, None)
        .await
        .or_failed()
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
        .or_failed()
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
    let ended = dispatch_entity::Entity::find()
        .filter(
            dispatch_entity::Column::State
                .is_in([DispatchState::Completed, DispatchState::Canceled]),
        )
        .filter(dispatch_entity::Column::FinishedAt.gte(done_from))
        .order_by_desc(dispatch_entity::Column::FinishedAt)
        .all(&db.conn)
        .await
        .or_failed();
    // A check of other work under acceptance says its word on that work's
    // row (7.5), not as one more piece of work with the same title; a check
    // of a message the owner asked about is listed, as what it is.
    let check_ids: Vec<i32> = ended.iter().filter(|d| d.is_check).map(|d| d.id).collect();
    let acceptance_checks =
        crate::db::service::personal_agent_verification_service::of_checks(&db.conn, &check_ids)
            .await
            .or_failed();
    for d in ended {
        let Some(bot) = d.bot_id.filter(|b| bot_ids.contains(b)) else {
            continue;
        };
        if acceptance_checks.contains_key(&d.id) {
            continue;
        }
        let kind = if d.is_check { "checked" } else { "finished" };
        let mut row = TodayRow::new(
            format!("{kind}:{}", d.id),
            kind,
            one_line(&d.title),
            d.finished_at.unwrap_or(d.updated_at),
        );
        row.bot_id = Some(bot);
        // What came of it in a plain sentence: not its first line, which is
        // as often a heading ("## Overview").
        row.text = d
            .result_excerpt
            .as_deref()
            .and_then(super::gist::plain_gist);
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
        .or_failed()
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
    .or_failed()
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
            Some(id) => svc::get_row(&db.conn, id).await.or_failed(),
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
    .or_failed()
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
                .or_failed()
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
        .or_failed()
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
    .or_failed()
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
                .or_failed()
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
    .or_failed()
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
                .or_failed()
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
            .or_failed()
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

    fn round(
        state: crate::db::entities::personal_agent_verification::VerificationState,
        run_seq: i32,
        unchecked: bool,
    ) -> crate::db::entities::personal_agent_verification::Model {
        let now = Utc::now();
        crate::db::entities::personal_agent_verification::Model {
            id: 1,
            bot_id: Some(1),
            dispatch_id: 1,
            check_dispatch_id: None,
            round: 1,
            run_seq,
            fingerprint: String::new(),
            state,
            check_verdict: None,
            check_evidence: None,
            decision: None,
            reason: None,
            message: None,
            question: None,
            decided_by: None,
            notice_id: None,
            unchecked,
            delivered_head: None,
            merge_commit: None,
            version_guaranteed: None,
            created_at: now,
            updated_at: now,
            decided_at: None,
        }
    }

    #[test]
    fn a_task_waits_on_the_owner_for_what_its_acceptance_and_the_board_leave_them() {
        use crate::db::entities::personal_agent_verification::VerificationState as V;
        use crate::personal_agent::ladder::tests::task;
        let review = |f: &dyn Fn(&mut crate::db::entities::work_task::Model)| {
            let mut t = task(WorkTaskStatus::Review);
            t.run_seq = 2;
            t.worktree_folder_id = Some(3);
            t.files_changed = Some(1);
            f(&mut t);
            t
        };
        let accepted = round(V::Accepted, 2, false);
        let plain = review(&|_| {});
        assert_eq!(task_reason(&plain, Some(&accepted), false), Some("merge_ready"));
        assert_eq!(task_reason(&plain, None, false), Some("review"));
        // A round for an earlier run is not this run's acceptance.
        assert_eq!(task_reason(&plain, Some(&round(V::Accepted, 1, false)), false), Some("review"));
        assert_eq!(
            task_reason(&plain, Some(&round(V::Accepted, 2, true)), false),
            Some("accepted_unchecked")
        );
        let from_pr = review(&|t| t.source_kind = Some("forge_pr".into()));
        assert_eq!(task_reason(&from_pr, Some(&accepted), false), Some("needs_delivery"));
        assert_eq!(task_reason(&from_pr, None, false), Some("review"));
        // Queued to merge: by the owner (no acceptance) or after it.
        let queued = review(&|t| t.pending_merge = Some(r#"{"queued_at":"2026-11-22T10:00:00Z"}"#.into()));
        assert_eq!(task_reason(&queued, Some(&accepted), false), Some("accepted_queued"));
        assert_eq!(task_reason(&queued, None, false), Some("merge_queued"));
        // Nothing to merge: the board offers to complete it, in its words.
        assert_eq!(task_reason(&review(&|t| t.files_changed = Some(0)), Some(&accepted), false), None);
        assert_eq!(task_reason(&review(&|t| t.worktree_folder_id = None), None, false), None);
        assert_eq!(task_reason(&plain, Some(&accepted), true), None);
        // Not a merge intent the board can read: nothing queued.
        let junk = review(&|t| t.pending_merge = Some("{}".into()));
        assert_eq!(task_reason(&junk, None, false), Some("review"));
        assert_eq!(task_reason(&task(WorkTaskStatus::Failed), None, false), Some("failed"));
        assert_eq!(task_reason(&task(WorkTaskStatus::AwaitingInput), None, false), None);
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
