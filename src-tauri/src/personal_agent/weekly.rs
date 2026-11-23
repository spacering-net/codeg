//! The weekly review (6.6, 3.1): once a week, the morning brief (or, as the
//! owner chose, Friday's wrap-up) carries a part on the week — the work
//! handed out, the questions answered for the owner, the assistants' talk,
//! the tokens by day and by assistant, and the figures of 3.1 — read from
//! codeg's own records, with no model. It only states them.
//!
//! Two questions come with it, as proposal cards after the brief: the kind
//! of change the owner keeps undoing (made at their word, undone after) —
//! show such changes first? — and a work assistant nobody woke for two
//! weeks — hide it or delete it?
//!
//! **When.** In the first brief of a workday each week, about the week
//! before (Monday 04:00 to Monday 04:00 in the owner's zone); in the
//! Friday-to-Sunday wrap-up, about the week so far. Once a week: the week
//! it was given in is noted when the brief is made.

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{DateTime, Datelike, Duration, NaiveDate, Utc, Weekday};
use chrono_tz::Tz;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::clock;
use super::due;
use super::presence::{self, hours_day, Hours, DAY_BREAK_HOUR};
use super::profile::{self, Held};
use crate::db::entities::personal_agent::{self as agent_entity, BotKind};
use crate::db::entities::personal_agent_action as action_entity;
use crate::db::entities::personal_agent_batch::{self as batch_entity, BatchKind};
use crate::db::entities::personal_agent_brief as brief_entity;
use crate::db::entities::personal_agent_dispatch::{
    self as dispatch_entity, DispatchMode, DispatchState,
};
use crate::db::entities::personal_agent_item::{self as item_entity, ItemStatus};
use crate::db::entities::personal_agent_message as message_entity;
use crate::db::entities::personal_agent_notice::{self as notice_entity, NoticeKind, NoticeState};
use crate::db::entities::personal_agent_routine_run::{self as run_entity, RunOutcome};
use crate::db::entities::personal_agent_timeline as timeline_entity;
use crate::db::entities::personal_agent_verification::{self as round_entity, VerificationState};
use crate::db::entities::personal_agent_watch as watch_entity;
use crate::db::entities::{token_usage_turn, work_task};
use crate::db::service::personal_agent_profile_service as psvc;
use crate::db::service::personal_agent_service as svc;
use crate::db::AppDatabase;
use crate::models::personal_agent_prefs::{ChatChanges, Prefs, WeeklyReview};

/// The questions look back this far: an assistant not woken, the changes
/// undone.
pub const IDLE_DAYS: i64 = 14;
/// Undone this many times at least…
pub const UNDO_MIN: u32 = 3;
/// …and at least half of those made, the owner is asked.
const UNDO_SHARE_PERCENT: u32 = 50;
/// Idle assistants asked about in one review, at most.
const IDLE_MAX: usize = 3;
/// Names listed in one line, at most.
const LIST_MAX: usize = 8;
/// Dispatches this far back are still followed for their tokens.
const USAGE_FOLLOW_DAYS: i64 = 60;

// ── which week ──────────────────────────────────────────────────────────────

/// A week of the owner's: Monday to Sunday, each day from 04:00.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WeekSpan {
    /// Its Monday.
    pub first: NaiveDate,
    /// The day after its last (the next Monday, or the day after today for
    /// the week so far).
    pub end: NaiveDate,
}

impl WeekSpan {
    pub fn label(&self) -> String {
        let w = self.first.iso_week();
        format!("{}-W{:02}", w.year(), w.week())
    }

    /// Its bounds in time: each day starts at 04:00 in `tz`.
    pub fn bounds(&self, tz: Tz) -> (DateTime<Utc>, DateTime<Utc>) {
        let at = |d: NaiveDate| {
            due::local_at(
                tz,
                d.and_hms_opt(DAY_BREAK_HOUR, 0, 0).expect("a valid hour"),
            )
        };
        (at(self.first), at(self.end))
    }
}

/// The Monday of `day`'s week.
pub fn monday_of(day: NaiveDate) -> NaiveDate {
    day - Duration::days(day.weekday().num_days_from_monday() as i64)
}

/// The label of the week `day` is in: the review given this week is noted
/// under it.
pub fn label_of(day: NaiveDate) -> String {
    WeekSpan {
        first: monday_of(day),
        end: monday_of(day) + Duration::days(7),
    }
    .label()
}

/// The week a `kind` (`brief` or `wrap`) of the owner's `day` reviews, if
/// it is the one to: the first brief of a workday reviews the week before;
/// a wrap-up from Friday the week so far. `given`: the week the last review
/// was given in.
pub fn due_week(
    pref: WeeklyReview,
    kind: &str,
    day: NaiveDate,
    given: Option<&str>,
) -> Option<WeekSpan> {
    if given == Some(label_of(day).as_str()) {
        return None;
    }
    let this = monday_of(day);
    match (pref, kind) {
        (WeeklyReview::Brief, "brief") if !due::is_rest_day(day) => Some(WeekSpan {
            first: this - Duration::days(7),
            end: this,
        }),
        (WeeklyReview::Wrap, "wrap")
            if matches!(day.weekday(), Weekday::Fri | Weekday::Sat | Weekday::Sun) =>
        {
            Some(WeekSpan {
                first: this,
                end: day + Duration::days(1),
            })
        }
        _ => None,
    }
}

/// The week the last review was given in.
pub async fn given(db: &AppDatabase) -> Option<String> {
    psvc::get(&db.conn, profile::WEEKLY_KEY)
        .await
        .ok()
        .flatten()
        .and_then(|v| v["given"].as_str().map(str::to_string))
}

/// Note that the review of the week of `day` was given, with the hours as
/// codeg had learned them (the next review says what changed).
pub async fn note_given(db: &AppDatabase, day: NaiveDate, hours: &Hours) {
    let v = json!({
        "given": label_of(day),
        "hours": hours_value(hours),
    });
    let _ = psvc::set(&db.conn, profile::WEEKLY_KEY, &v, clock::now()).await;
}

/// Note that `m`'s week was given (the brief carrying it was just made).
pub async fn note_given_of(db: &AppDatabase, m: &super::brief::Material, prefs: &Prefs) {
    let Ok(day) = NaiveDate::parse_from_str(&m.day, "%Y-%m-%d") else {
        return;
    };
    let hours = presence::learned_hours(&db.conn, prefs, clock::now()).await;
    note_given(db, day, &hours).await;
}

fn hours_value(h: &Hours) -> Value {
    json!({
        "workday": [h.workday.start, h.workday.end, h.workday.learned],
        "restday": [h.restday.start, h.restday.end, h.restday.learned],
    })
}

// ── what a week holds ───────────────────────────────────────────────────────

/// A name and how many.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Count {
    pub id: i32,
    pub name: String,
    pub n: u32,
}

/// An assistant's tokens: its brain's conversations, and the work it handed
/// out.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct BotTokens {
    pub bot_id: i32,
    pub name: String,
    pub own: i64,
    pub handed_out: i64,
}

/// A question for the owner the review comes with (a proposal card).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WeekAsk {
    /// `undo` or `idle_bot`.
    pub rule: String,
    #[serde(default)]
    pub bot_id: Option<i32>,
    #[serde(default)]
    pub name: Option<String>,
    /// `undo`: undone, of made, in the last two weeks.
    #[serde(default)]
    pub undone: u32,
    #[serde(default)]
    pub made: u32,
    /// `idle_bot`: when it was last woken (never: when it was made).
    #[serde(default)]
    pub since: Option<DateTime<Utc>>,
}

/// One week, as the review states it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Week {
    pub label: String,
    /// Its first and last day, `YYYY-MM-DD`.
    pub first: String,
    pub last: String,
    /// The week so far (a Friday wrap-up).
    pub so_far: bool,
    // The work handed out.
    pub dispatched: u32,
    pub by_bot: Vec<Count>,
    /// `task`, `chat`, `session`.
    pub by_mode: BTreeMap<String, u32>,
    pub completed: u32,
    pub failed: u32,
    pub settled: u32,
    pub first_pass: u32,
    /// Rounds of acceptance that sent work back.
    pub caught: u32,
    /// Work codeg retried on its own.
    pub retried: u32,
    /// Routine runs that got done (reported or nothing to say).
    pub routine_done: u32,
    /// Rounds codeg ran by itself on a pull request's failed checks or
    /// conflict (7.4, phase 3).
    #[serde(default)]
    pub ci_fixed: u32,
    /// Pull requests an assistant merged.
    pub merged: u32,
    // Questions from the work, answered for the owner.
    pub asked: u32,
    pub plans: u32,
    pub answered_by: Vec<Count>,
    pub forwarded: u32,
    // Between the assistants.
    pub messages: u32,
    pub threads: u32,
    pub loops: u32,
    // Tokens.
    pub tokens: i64,
    /// By the owner's day, `YYYY-MM-DD`.
    pub tokens_by_day: Vec<(String, i64)>,
    pub tokens_by_bot: Vec<BotTokens>,
    // How soon the owner answered what waited on them.
    pub unblock_minutes: Option<u32>,
    pub unblocked: u32,
    /// The week before.
    pub unblock_before: Option<u32>,
    /// News that did not go out at once.
    pub held: Held,
    // Briefs and wrap-ups.
    pub briefs: u32,
    pub wraps: u32,
    /// Work and messages the owner chose for tonight.
    pub tonight: u32,
    // Proposals: codeg's rules and the assistants' suggestions.
    pub proposals: u32,
    pub proposals_taken: u32,
    pub proposals_dismissed: u32,
    /// Rules turned off from a card this week.
    pub muted_rules: Vec<String>,
    /// Rules codeg lowered this week (their cards kept dismissed).
    pub lowered: Vec<String>,
    // Undone: changes made at the owner's word, memory written.
    pub changes: u32,
    pub changes_undone: u32,
    pub memory: u32,
    pub memory_undone: u32,
    // Reminders.
    pub reminders: u32,
    pub reminders_done: u32,
    pub reminders_snoozed: u32,
    // Patterns.
    /// Offers to make a repeated request a routine.
    pub repeat_offers: u32,
    /// Matters untouched a week or more.
    pub idle_items: u32,
    /// What changed of the hours codeg learned since the last review.
    pub hours_note: Option<String>,
    /// The questions for the owner that come with it.
    pub asks: Vec<WeekAsk>,
}

impl Week {
    /// Nothing at all happened.
    pub fn is_quiet(&self) -> bool {
        self.dispatched == 0
            && self.asked == 0
            && self.messages == 0
            && self.tokens == 0
            && self.proposals == 0
            && self.reminders == 0
            && self.changes == 0
            && self.memory == 0
            && self.asks.is_empty()
    }
}

fn name_of(bots: &HashMap<i32, agent_entity::Model>, id: i32) -> String {
    bots.get(&id)
        .map(super::messages::display_name)
        .unwrap_or_else(|| format!("#{id}"))
}

fn ranked(map: HashMap<i32, (String, u32)>) -> Vec<Count> {
    let mut v: Vec<Count> = map
        .into_iter()
        .map(|(id, (name, n))| Count { id, name, n })
        .collect();
    v.sort_by(|a, b| b.n.cmp(&a.n).then_with(|| a.name.cmp(&b.name)));
    v
}

fn row_data(rows: &HashMap<i32, timeline_entity::Model>, n: &notice_entity::Model) -> Value {
    n.timeline_id
        .and_then(|id| rows.get(&id))
        .and_then(|r| r.data.as_deref())
        .and_then(|d| serde_json::from_str(d).ok())
        .unwrap_or(Value::Null)
}

async fn rows_of(db: &AppDatabase, ids: Vec<i32>) -> HashMap<i32, timeline_entity::Model> {
    let mut out = HashMap::new();
    for chunk in ids.chunks(500) {
        for r in timeline_entity::Entity::find()
            .filter(timeline_entity::Column::Id.is_in(chunk.to_vec()))
            .all(&db.conn)
            .await
            .unwrap_or_default()
        {
            out.insert(r.id, r);
        }
    }
    out
}

/// The kinds of card that wait on the owner to decide (3.1 "unblocked").
const WAITS_ON_OWNER: &[NoticeKind] = &[
    NoticeKind::Proposal,
    NoticeKind::Choice,
    NoticeKind::Uncertain,
    NoticeKind::Loop,
    NoticeKind::Acceptance,
    NoticeKind::Ask,
];

/// Whether a card waited on the owner and they answered it: an executor's
/// question the assistant answered is not theirs.
fn owner_answered(n: &notice_entity::Model, data: &Value) -> bool {
    if !WAITS_ON_OWNER.contains(&n.kind)
        || !matches!(
            n.state,
            NoticeState::Acted | NoticeState::Dismissed | NoticeState::Unknown
        )
    {
        return false;
    }
    if n.kind == NoticeKind::Ask {
        return data["answered_by"]["kind"].as_str() == Some("owner");
    }
    // A card an assistant suggested is no wait.
    data["why"].as_str() != Some("proposal")
}

/// The average minutes from raised to answered of the cards that waited on
/// the owner and were answered in `[from, to)`.
async fn unblock(db: &AppDatabase, from: DateTime<Utc>, to: DateTime<Utc>) -> (Option<u32>, u32) {
    let cards = notice_entity::Entity::find()
        .filter(notice_entity::Column::Kind.is_in(WAITS_ON_OWNER.to_vec()))
        .filter(notice_entity::Column::ActedAt.gte(from))
        .filter(notice_entity::Column::ActedAt.lt(to))
        .all(&db.conn)
        .await
        .unwrap_or_default();
    let rows = rows_of(db, cards.iter().filter_map(|n| n.timeline_id).collect()).await;
    let waits: Vec<i64> = cards
        .iter()
        .filter(|n| owner_answered(n, &row_data(&rows, n)))
        .filter_map(|n| n.acted_at.map(|a| (a - n.created_at).num_minutes().max(0)))
        .collect();
    if waits.is_empty() {
        return (None, 0);
    }
    let n = waits.len() as i64;
    (
        u32::try_from((waits.iter().sum::<i64>() + n / 2) / n).ok(),
        waits.len() as u32,
    )
}

/// Each assistant's own conversations and those of the work it handed out,
/// with the sessions either went on in (a delegation's children).
async fn conversations_of(
    db: &AppDatabase,
    bots: &[agent_entity::Model],
    from: DateTime<Utc>,
) -> (HashMap<i32, i32>, HashMap<i32, i32>) {
    let mut own: HashMap<i32, i32> = HashMap::new();
    for b in bots {
        for s in svc::list_segments(&db.conn, b.id).await.unwrap_or_default() {
            if let Some(c) = s.conversation_id {
                own.insert(c, b.id);
            }
        }
    }
    let dispatches = dispatch_entity::Entity::find()
        .filter(dispatch_entity::Column::CreatedAt.gte(from - Duration::days(USAGE_FOLLOW_DAYS)))
        .all(&db.conn)
        .await
        .unwrap_or_default();
    let mut handed: HashMap<i32, i32> = HashMap::new();
    let mut task_bot: HashMap<i32, i32> = HashMap::new();
    for d in &dispatches {
        let Some(bot) = d.bot_id else { continue };
        if let Some(c) = d.conversation_id {
            handed.insert(c, bot);
        }
        if let Some(t) = d.work_task_id {
            task_bot.insert(t, bot);
        }
    }
    let tasks: Vec<i32> = task_bot.keys().copied().collect();
    for chunk in tasks.chunks(500) {
        for t in work_task::Entity::find()
            .filter(work_task::Column::Id.is_in(chunk.to_vec()))
            .all(&db.conn)
            .await
            .unwrap_or_default()
        {
            if let (Some(c), Some(b)) = (t.conversation_id, task_bot.get(&t.id)) {
                handed.insert(c, *b);
            }
        }
    }
    // The sessions their work runs on in (a delegation's children) are
    // theirs too, as the usage summary counts them.
    Box::pin(super::overview::with_children(db, &mut own, &mut handed)).await;
    (own, handed)
}

/// Gather week `w` (in the owner's zone `tz`) as of `now`.
pub async fn gather(db: &AppDatabase, prefs: &Prefs, w: WeekSpan, now: DateTime<Utc>) -> Week {
    let tz = clock::zone_of(&prefs.time_zone);
    let (from, end) = w.bounds(tz);
    let to = end.min(now + Duration::seconds(1));
    let all_bots: HashMap<i32, agent_entity::Model> = agent_entity::Entity::find()
        .all(&db.conn)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|b| (b.id, b))
        .collect();
    let mut week = Week {
        label: w.label(),
        first: w.first.format("%Y-%m-%d").to_string(),
        last: (w.end - Duration::days(1)).format("%Y-%m-%d").to_string(),
        so_far: end > now,
        ..Week::default()
    };

    // The work handed out.
    let work = profile::graded_between(db, from, to).await;
    let mut by_bot: HashMap<i32, (String, u32)> = HashMap::new();
    for g in &work {
        week.dispatched += 1;
        if let Some(b) = g.bot_id {
            by_bot
                .entry(b)
                .or_insert_with(|| (name_of(&all_bots, b), 0))
                .1 += 1;
        }
        let mode = match g.mode {
            DispatchMode::Task => "task",
            DispatchMode::Chat => "chat",
            DispatchMode::Session => "session",
        };
        *week.by_mode.entry(mode.into()).or_insert(0) += 1;
        match g.state {
            DispatchState::Completed => week.completed += 1,
            DispatchState::Failed | DispatchState::Interrupted => week.failed += 1,
            _ => {}
        }
    }
    let grade = profile::grade_of(work.iter());
    week.settled = grade.settled;
    week.first_pass = grade.first_pass;
    week.by_bot = ranked(by_bot);
    week.caught = round_entity::Entity::find()
        .filter(round_entity::Column::State.eq(VerificationState::Revised))
        .filter(round_entity::Column::UpdatedAt.gte(from))
        .filter(round_entity::Column::UpdatedAt.lt(to))
        .all(&db.conn)
        .await
        .map(|v| v.len() as u32)
        .unwrap_or(0);
    week.retried = action_entity::Entity::find()
        .filter(action_entity::Column::OpId.starts_with("pa-retry-"))
        .filter(action_entity::Column::CreatedAt.gte(from))
        .filter(action_entity::Column::CreatedAt.lt(to))
        .all(&db.conn)
        .await
        .map(|v| v.len() as u32)
        .unwrap_or(0);
    week.routine_done = run_entity::Entity::find()
        .filter(run_entity::Column::StartedAt.gte(from))
        .filter(run_entity::Column::StartedAt.lt(to))
        .filter(run_entity::Column::Outcome.is_in([RunOutcome::Reported, RunOutcome::Silent]))
        .all(&db.conn)
        .await
        .map(|v| v.len() as u32)
        .unwrap_or(0);
    // The pull requests codeg set out to fix by itself: its rounds on failed
    // checks and conflicts, as each watch keeps them.
    week.ci_fixed = watch_entity::Entity::find()
        .filter(watch_entity::Column::Auto.is_not_null())
        .all(&db.conn)
        .await
        .unwrap_or_default()
        .iter()
        .map(|w| {
            super::pr_auto::auto_of(w)
                .rounds
                .iter()
                .filter(|r| r.cause != super::pr_auto::Cause::Feedback && r.at >= from && r.at < to)
                .count() as u32
        })
        .sum();

    // Every card raised this week, and the rows they are on.
    let cards = profile::cards_between(db, from, to).await;
    let rows = rows_of(db, cards.iter().filter_map(|n| n.timeline_id).collect()).await;
    let mut answered: HashMap<i32, (String, u32)> = HashMap::new();
    for n in &cards {
        let data = row_data(&rows, n);
        let payload: Value = serde_json::from_str(&n.payload).unwrap_or(Value::Null);
        match n.kind {
            NoticeKind::Ask if data["mirror_of"].is_null() => {
                week.asked += 1;
                if data["request"].as_str().is_some_and(|r| r != "question") {
                    week.plans += 1;
                }
                if data["forwarded_at"].is_string() || data["forward_reason"].is_string() {
                    week.forwarded += 1;
                }
                if data["state"].as_str() == Some("answered")
                    && data["answered_by"]["kind"].as_str() == Some("assistant")
                {
                    let b = data["answered_by"]["bot_id"]
                        .as_i64()
                        .and_then(|b| i32::try_from(b).ok())
                        .or(n.bot_id)
                        .unwrap_or(0);
                    answered
                        .entry(b)
                        .or_insert_with(|| (name_of(&all_bots, b), 0))
                        .1 += 1;
                }
            }
            NoticeKind::Loop => week.loops += 1,
            NoticeKind::Forge => {
                if payload["call"]["action"].as_str() == Some("merge")
                    && n.state == NoticeState::Acted
                {
                    week.merged += 1;
                }
            }
            NoticeKind::Reminder => {
                week.reminders += 1;
                match data["state"].as_str() {
                    Some("done") => week.reminders_done += 1,
                    Some("snoozed") => week.reminders_snoozed += 1,
                    _ => {}
                }
            }
            NoticeKind::Memory => {
                week.memory += 1;
                if n.state == NoticeState::Undone {
                    week.memory_undone += 1;
                }
            }
            NoticeKind::Changed | NoticeKind::Routine if made_at_word(n, &payload, &data) => {
                week.changes += 1;
                if n.state == NoticeState::Undone {
                    week.changes_undone += 1;
                }
            }
            _ => {}
        }
        if n.kind == NoticeKind::Routine && payload["what"].as_str() == Some("repeat") {
            week.repeat_offers += 1;
        }
        if super::rules::rule_of_card(n, &data).is_some() {
            week.proposals += 1;
            match n.state {
                NoticeState::Acting | NoticeState::Acted | NoticeState::Unknown => {
                    week.proposals_taken += 1
                }
                NoticeState::Dismissed | NoticeState::Muted => week.proposals_dismissed += 1,
                _ => {}
            }
        }
    }
    week.answered_by = ranked(answered);
    for v in super::rules::rule_views(db).await {
        if v.muted_at.is_some_and(|t| t >= from && t < to) {
            week.muted_rules.push(v.rule.to_string());
        }
        if v.quiet_since.is_some_and(|t| t >= from && t < to) {
            week.lowered.push(v.rule.to_string());
        }
    }

    // Between the assistants.
    let messages = message_entity::Entity::find()
        .filter(message_entity::Column::CreatedAt.gte(from))
        .filter(message_entity::Column::CreatedAt.lt(to))
        .all(&db.conn)
        .await
        .unwrap_or_default();
    week.messages = messages.len() as u32;
    week.threads = messages
        .iter()
        .filter_map(|m| m.thread_id)
        .collect::<HashSet<_>>()
        .len() as u32;

    // Tokens: every conversation's by day; each assistant's own and handed
    // out.
    let bots: Vec<agent_entity::Model> = all_bots
        .values()
        .filter(|b| b.deleted_at.is_none())
        .cloned()
        .collect();
    let (own, handed) = conversations_of(db, &bots, from).await;
    let turns = token_usage_turn::Entity::find()
        .filter(token_usage_turn::Column::OccurredAt.gte(from))
        .filter(token_usage_turn::Column::OccurredAt.lt(to))
        .all(&db.conn)
        .await
        .unwrap_or_default();
    let mut by_day: BTreeMap<String, i64> = BTreeMap::new();
    let mut d = w.first;
    while d < w.end {
        by_day.insert(d.format("%Y-%m-%d").to_string(), 0);
        d += Duration::days(1);
    }
    let mut per_bot: HashMap<i32, BotTokens> = HashMap::new();
    for t in &turns {
        let day = hours_day(t.occurred_at, tz).format("%Y-%m-%d").to_string();
        if let Some(n) = by_day.get_mut(&day) {
            *n += t.total_tokens;
        }
        week.tokens += t.total_tokens;
        let (bot, mine) = match (own.get(&t.conversation_id), handed.get(&t.conversation_id)) {
            (Some(b), _) => (*b, true),
            (None, Some(b)) => (*b, false),
            _ => continue,
        };
        let e = per_bot.entry(bot).or_insert_with(|| BotTokens {
            bot_id: bot,
            name: name_of(&all_bots, bot),
            ..Default::default()
        });
        if mine {
            e.own += t.total_tokens;
        } else {
            e.handed_out += t.total_tokens;
        }
    }
    week.tokens_by_day = by_day.into_iter().collect();
    let mut per_bot: Vec<BotTokens> = per_bot.into_values().collect();
    per_bot.sort_by_key(|b| std::cmp::Reverse(b.own + b.handed_out));
    week.tokens_by_bot = per_bot;

    // How soon the owner answered, this week and the one before.
    let (m, n) = unblock(db, from, to).await;
    week.unblock_minutes = m;
    week.unblocked = n;
    week.unblock_before = unblock(db, from - Duration::days(7), from).await.0;
    week.held = profile::held_between(db, w.first, w.end).await;

    // Briefs and wrap-ups that reached the owner, and tonight's work.
    for b in brief_entity::Entity::find()
        .filter(brief_entity::Column::CreatedAt.gte(from))
        .filter(brief_entity::Column::CreatedAt.lt(to))
        .all(&db.conn)
        .await
        .unwrap_or_default()
    {
        if b.state != crate::db::service::personal_agent_brief_service::DELIVERED {
            continue;
        }
        if b.kind == "wrap" {
            week.wraps += 1;
            let t = super::brief::Tonight::parse(b.tonight.as_deref());
            week.tonight += (t.dispatches.len() + t.messages.len()) as u32;
        } else {
            week.briefs += 1;
        }
    }

    // Matters gone quiet.
    week.idle_items = item_entity::Entity::find()
        .filter(item_entity::Column::Status.is_in([ItemStatus::Open, ItemStatus::Waiting]))
        .filter(item_entity::Column::UpdatedAt.lt(to - Duration::days(7)))
        .all(&db.conn)
        .await
        .map(|v| v.len() as u32)
        .unwrap_or(0);

    // The hours learned since the last review.
    let hours = presence::learned_hours(&db.conn, prefs, now).await;
    if let Some(before) = psvc::get(&db.conn, profile::WEEKLY_KEY)
        .await
        .ok()
        .flatten()
        .map(|v| v["hours"].clone())
        .filter(|v| !v.is_null())
    {
        week.hours_note = hours_change(&before, &hours);
    }

    week.asks = asks(db, prefs, &bots, now).await;
    week
}

/// A card for a change made at the owner's word: a setting, an assistant, an
/// executor config, a routine made or changed — not one only suggested, and
/// not one still waiting to be confirmed. A changed setting's card is acted
/// once made; a routine's stays open (its [Undo] is on it) until undone.
fn made_at_word(n: &notice_entity::Model, payload: &Value, data: &Value) -> bool {
    match n.kind {
        NoticeKind::Changed => {
            matches!(n.state, NoticeState::Acted | NoticeState::Undone)
                && payload["why"].as_str() != Some("suggest")
                && data["why"].as_str() != Some("suggest")
        }
        NoticeKind::Routine => matches!(payload["what"].as_str(), Some("made" | "changed")),
        _ => false,
    }
}

/// What changed of the learned hours since `before` (as noted at the last
/// review), in a line; `None`: nothing worth saying (under a quarter hour).
fn hours_change(before: &Value, now: &Hours) -> Option<String> {
    let mut parts = Vec::new();
    for (name, d) in [("workday", now.workday), ("restday", now.restday)] {
        let b = &before[name];
        let (Some(s), Some(e)) = (b[0].as_u64(), b[1].as_u64()) else {
            continue;
        };
        let was_learned = b[2].as_bool().unwrap_or(false);
        if !d.learned {
            continue;
        }
        let moved =
            (d.start as i64 - s as i64).abs() >= 15 || (d.end as i64 - e as i64).abs() >= 15;
        if moved || !was_learned {
            parts.push(format!(
                "{name}s now {}–{}{}",
                presence::clock_words(d.start),
                presence::clock_words(d.end),
                if was_learned {
                    format!(
                        " (were {}–{})",
                        presence::clock_words(s as u32),
                        presence::clock_words(e as u32)
                    )
                } else {
                    " (newly learned)".into()
                }
            ));
        }
    }
    (!parts.is_empty()).then(|| parts.join("; "))
}

/// The questions for the owner: the changes they keep undoing, the work
/// assistants nobody woke for two weeks.
async fn asks(
    db: &AppDatabase,
    prefs: &Prefs,
    bots: &[agent_entity::Model],
    now: DateTime<Utc>,
) -> Vec<WeekAsk> {
    let mut out = Vec::new();
    let since = now - Duration::days(IDLE_DAYS);
    if prefs.records_reactions()
        && prefs.rule_on("undo")
        && prefs.chat_changes == ChatChanges::Apply
    {
        // Undoing is the owner's answer: what they cleared counts no more.
        let from = match profile::cleared_at(db).await {
            Some(c) if c > since => c,
            _ => since,
        };
        let cards = notice_entity::Entity::find()
            .filter(notice_entity::Column::Kind.is_in([NoticeKind::Changed, NoticeKind::Routine]))
            .filter(notice_entity::Column::CreatedAt.gte(from))
            .all(&db.conn)
            .await
            .unwrap_or_default();
        let rows = rows_of(db, cards.iter().filter_map(|n| n.timeline_id).collect()).await;
        let mut made = 0;
        let mut undone = 0;
        for n in &cards {
            let payload: Value = serde_json::from_str(&n.payload).unwrap_or(Value::Null);
            if made_at_word(n, &payload, &row_data(&rows, n)) {
                made += 1;
                if n.state == NoticeState::Undone {
                    undone += 1;
                }
            }
        }
        if undone >= UNDO_MIN && undone * 100 >= made * UNDO_SHARE_PERCENT {
            out.push(WeekAsk {
                rule: "undo".into(),
                bot_id: None,
                name: None,
                undone,
                made,
                since: None,
            });
        }
    }
    if prefs.rule_on("idle_bot") {
        let mut idle = Vec::new();
        for b in bots
            .iter()
            .filter(|b| b.kind == BotKind::Worker && !b.hidden && b.deleted_at.is_none())
            .filter(|b| b.created_at < since)
        {
            let last = batch_entity::Entity::find()
                .filter(batch_entity::Column::BotId.eq(b.id))
                .filter(batch_entity::Column::Kind.eq(BatchKind::Delivery))
                .filter(batch_entity::Column::StartedAt.gte(since))
                .one(&db.conn)
                .await
                .ok()
                .flatten();
            if last.is_some() {
                continue;
            }
            let woken = svc::batches_since(&db.conn, b.id, b.created_at)
                .await
                .unwrap_or_default()
                .into_iter()
                .filter(|x| x.kind == BatchKind::Delivery)
                .map(|x| x.started_at)
                .max();
            idle.push(WeekAsk {
                rule: "idle_bot".into(),
                bot_id: Some(b.id),
                name: Some(super::messages::display_name(b)),
                undone: 0,
                made: 0,
                since: Some(woken.unwrap_or(b.created_at)),
            });
        }
        idle.sort_by_key(|a| a.since);
        idle.truncate(IDLE_MAX);
        out.extend(idle);
    }
    out
}

// ── the questions, as cards ─────────────────────────────────────────────────

impl super::engine::PersonalAgentEngine {
    /// Put the week's questions in front of the owner, as proposal cards on
    /// this (the primary) assistant's conversation: once a week each, a
    /// question they dismissed quiet a week (6.7), none for a rule they
    /// turned off since.
    pub(super) async fn raise_week_asks(&self, w: &Week, prefs: &Prefs) {
        let now = clock::now();
        let bot = self.bot().await;
        for a in &w.asks {
            let (rule, object, text, facts): (&'static str, String, String, Value) =
                match a.rule.as_str() {
                    "undo" => (
                        "undo",
                        "changes".into(),
                        format!(
                            "{} of the {} changes made at your word in two weeks were undone",
                            a.undone, a.made
                        ),
                        json!({ "undone": a.undone, "made": a.made, "week": w.label }),
                    ),
                    "idle_bot" => {
                        let Some(id) = a.bot_id else { continue };
                        // Gone or hidden since: nothing to ask.
                        match svc::get_bot(&self.db.conn, id).await.ok().flatten() {
                            Some(b) if !b.hidden => {}
                            _ => continue,
                        }
                        let name = a.name.clone().unwrap_or_default();
                        (
                            "idle_bot",
                            format!("bot:{id}"),
                            format!("{name} has not been woken for two weeks"),
                            json!({
                                "bot_id": id,
                                "name": name,
                                "since": a.since,
                                "week": w.label,
                            }),
                        )
                    }
                    _ => continue,
                };
            if !prefs.rule_on(rule) {
                continue;
            }
            let subject = super::rules::subject(rule, &object);
            let earlier = crate::db::service::personal_agent_rule_service::notices_of_subject(
                &self.db.conn,
                &subject,
            )
            .await
            .unwrap_or_default();
            if !super::rules::may_raise(&earlier, &w.label, now) {
                continue;
            }
            let found = super::rules::Found {
                rule,
                object,
                episode: w.label.clone(),
                bot,
                since: a.since.unwrap_or(now),
                held: false,
                facts,
                text,
            };
            if let Err(e) = self.raise_rule_card(&found, prefs, false).await {
                tracing::warn!("[personal-agent] the weekly review's question was not raised: {e}");
            }
        }
    }
}

// ── for the brain ───────────────────────────────────────────────────────────

fn list(v: &[Count]) -> String {
    let mut s: Vec<String> = v
        .iter()
        .take(LIST_MAX)
        .map(|c| format!("{} {}", c.name, c.n))
        .collect();
    if v.len() > LIST_MAX {
        s.push(format!("+{} more", v.len() - LIST_MAX));
    }
    s.join(", ")
}

fn tokens_words(n: i64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    } else if n >= 1_000 {
        format!("{:.1}k", n as f64 / 1_000.0)
    } else {
        n.to_string()
    }
}

/// The week as lines of the brain's materials.
pub fn lines(w: &Week) -> Vec<String> {
    let mut out = Vec::new();
    let modes: Vec<String> = w.by_mode.iter().map(|(m, n)| format!("{m} {n}")).collect();
    out.push(format!(
        "- handed out: {} ({}) · completed {}, failed {} · passed the first time {} of {} settled · \
         sent back by acceptance {} · retried by codeg {} · pull requests' checks or conflicts \
         fixed by codeg {} · routine runs done {} · pull requests merged by an assistant {}",
        w.dispatched,
        if modes.is_empty() { "none".into() } else { modes.join(", ") },
        w.completed,
        w.failed,
        w.first_pass,
        w.settled,
        w.caught,
        w.retried,
        w.ci_fixed,
        w.routine_done,
        w.merged
    ));
    if !w.by_bot.is_empty() {
        out.push(format!("- handed out by assistant: {}", list(&w.by_bot)));
    }
    // No line by executor config: no executor config's name reaches the
    // brain (it is on the owner's card only).
    out.push(format!(
        "- the work's questions and plan approvals: {} ({} plans) · answered by the assistants: {} · \
         went to the owner: {}",
        w.asked,
        w.plans,
        if w.answered_by.is_empty() {
            "none".into()
        } else {
            list(&w.answered_by)
        },
        w.forwarded
    ));
    out.push(format!(
        "- between the assistants: {} messages on {} threads · exchanges stopped for going round: {}",
        w.messages, w.threads, w.loops
    ));
    let days: Vec<String> = w
        .tokens_by_day
        .iter()
        .map(|(d, n)| format!("{} {}", &d[5..], tokens_words(*n)))
        .collect();
    out.push(format!(
        "- tokens: {} in all · by day: {}",
        tokens_words(w.tokens),
        days.join(", ")
    ));
    if !w.tokens_by_bot.is_empty() {
        let bots: Vec<String> = w
            .tokens_by_bot
            .iter()
            .map(|b| {
                format!(
                    "{} (assistant #{}) {} — its own {}, its handed-out work {}",
                    b.name,
                    b.bot_id,
                    tokens_words(b.own + b.handed_out),
                    tokens_words(b.own),
                    tokens_words(b.handed_out)
                )
            })
            .collect();
        out.push(format!("- tokens by assistant: {}", bots.join("; ")));
    }
    let unblock = match (w.unblock_minutes, w.unblock_before) {
        (Some(m), Some(b)) => format!(
            "{} on average over {} answers (the week before: {})",
            due::span(Duration::minutes(m as i64)),
            w.unblocked,
            due::span(Duration::minutes(b as i64))
        ),
        (Some(m), None) => format!(
            "{} on average over {} answers",
            due::span(Duration::minutes(m as i64)),
            w.unblocked
        ),
        _ => "nothing waited on them".into(),
    };
    out.push(format!(
        "- how soon the owner answered what waited on them: {unblock}"
    ));
    out.push(format!(
        "- notifications spared: {} merged into a digest, {} held until they were back or done typing, \
         {} kept to the day's list",
        w.held.merged, w.held.deferred, w.held.kept
    ));
    out.push(format!(
        "- briefs delivered {}, wrap-ups {} · work and messages chosen for tonight {}",
        w.briefs, w.wraps, w.tonight
    ));
    let mut p = format!(
        "- proposals: {} raised, {} taken, {} declined",
        w.proposals, w.proposals_taken, w.proposals_dismissed
    );
    if !w.muted_rules.is_empty() {
        p.push_str(&format!(
            " · turned off from a card: {}",
            w.muted_rules.join(", ")
        ));
    }
    out.push(p);
    out.push(format!(
        "- undone by the owner: {} of {} changes made at their word, {} of {} memory changes",
        w.changes_undone, w.changes, w.memory_undone, w.memory
    ));
    out.push(format!(
        "- reminders: {} came due, {} done, {} snoozed",
        w.reminders, w.reminders_done, w.reminders_snoozed
    ));
    out.push(format!(
        "- patterns: {} offers to make a repeated request a routine · {} matters untouched a week or more",
        w.repeat_offers, w.idle_items
    ));
    let mut adjusted = Vec::new();
    if !w.lowered.is_empty() {
        adjusted.push(format!(
            "lowered the cards of rules {} one level (the owner kept dismissing them)",
            w.lowered.join(", ")
        ));
    }
    if let Some(h) = &w.hours_note {
        adjusted.push(format!("the usual hours: {h}"));
    }
    if !adjusted.is_empty() {
        out.push(format!("- what codeg adjusted: {}", adjusted.join("; ")));
    }
    for a in &w.asks {
        out.push(match a.rule.as_str() {
            "undo" => format!(
                "- codeg asks on a card after yours: the owner undid {} of the {} changes made at \
                 their word in two weeks — show such changes first?",
                a.undone, a.made
            ),
            _ => format!(
                "- codeg asks on a card after yours: {} (assistant #{}) has not been woken for two \
                 weeks — hide it or delete it?",
                a.name.as_deref().unwrap_or(""),
                a.bot_id.unwrap_or(0)
            ),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn the_first_workday_brief_reviews_the_week_before_once() {
        // Monday 2026-11-16.
        let w = due_week(WeeklyReview::Brief, "brief", d("2026-11-16"), None).unwrap();
        assert_eq!((w.first, w.end), (d("2026-11-09"), d("2026-11-16")));
        assert_eq!(w.label(), "2026-W46");
        // Given this week already: not again on Tuesday.
        assert_eq!(
            due_week(
                WeeklyReview::Brief,
                "brief",
                d("2026-11-17"),
                Some("2026-W47")
            ),
            None
        );
        // Not on Monday: Tuesday's brief is the first.
        assert!(due_week(
            WeeklyReview::Brief,
            "brief",
            d("2026-11-17"),
            Some("2026-W46")
        )
        .is_some());
        // Not on a rest day.
        assert_eq!(
            due_week(WeeklyReview::Brief, "brief", d("2026-11-15"), None),
            None
        );
        // Not in a wrap-up, nor when off.
        assert_eq!(
            due_week(WeeklyReview::Brief, "wrap", d("2026-11-16"), None),
            None
        );
        assert_eq!(
            due_week(WeeklyReview::Off, "brief", d("2026-11-16"), None),
            None
        );
    }

    #[test]
    fn a_week_of_nothing_says_nothing() {
        let mut w = Week::default();
        assert!(w.is_quiet());
        w.tokens = 1;
        assert!(!w.is_quiet());
        let w = Week {
            asks: vec![WeekAsk {
                rule: "idle_bot".into(),
                bot_id: Some(2),
                name: None,
                undone: 0,
                made: 0,
                since: None,
            }],
            ..Week::default()
        };
        assert!(!w.is_quiet(), "a question to ask is something to say");
    }

    #[test]
    fn a_wrap_up_from_friday_reviews_the_week_so_far() {
        assert_eq!(
            due_week(WeeklyReview::Wrap, "wrap", d("2026-11-19"), None),
            None
        );
        let w = due_week(WeeklyReview::Wrap, "wrap", d("2026-11-20"), None).unwrap();
        assert_eq!((w.first, w.end), (d("2026-11-16"), d("2026-11-21")));
        assert_eq!(
            due_week(
                WeeklyReview::Wrap,
                "wrap",
                d("2026-11-21"),
                Some("2026-W47")
            ),
            None
        );
        assert_eq!(
            due_week(WeeklyReview::Wrap, "brief", d("2026-11-20"), None),
            None
        );
    }

    #[test]
    fn a_week_runs_from_monday_at_four_in_the_owners_zone() {
        let tz: Tz = "Asia/Shanghai".parse().unwrap();
        let w = WeekSpan {
            first: d("2026-11-09"),
            end: d("2026-11-16"),
        };
        let (from, to) = w.bounds(tz);
        assert_eq!(from.to_rfc3339(), "2026-11-08T20:00:00+00:00");
        assert_eq!(to.to_rfc3339(), "2026-11-15T20:00:00+00:00");
    }

    #[test]
    fn the_learned_hours_say_what_moved_since_the_last_review() {
        let before = json!({ "workday": [540, 1080, true], "restday": [540, 1080, false] });
        let mut h = Hours::default();
        h.workday.start = 540 + 10;
        h.workday.learned = true;
        assert_eq!(hours_change(&before, &h), None, "under a quarter hour");
        h.workday.start = 600;
        h.restday.learned = true;
        h.restday.start = 660;
        let note = hours_change(&before, &h).unwrap();
        assert!(
            note.contains("workdays now 10:00–18:00 (were 09:00–18:00)"),
            "{note}"
        );
        assert!(
            note.contains("restdays now 11:00–18:00 (newly learned)"),
            "{note}"
        );
    }
}
