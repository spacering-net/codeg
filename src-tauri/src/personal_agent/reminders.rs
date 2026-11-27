//! Matters with a time (6.1): the clock that fires them, the reminder card,
//! and what the owner does about a matter without the assistant.
//!
//! **Firing.** Every [`DUE_TICK`] each assistant's engine looks at its own
//! matters due by now. A `notify` one puts a reminder card in its
//! conversation — codeg's own, no model — and the assistant hears with its
//! next delivery that the owner was reminded; an `act` one wakes the
//! assistant with an event carrying what it is to do, numbered by a card
//! saying so. A matter fires once per occurrence (`fired_at`), claimed in
//! the same transaction that writes its card and event. One whose time went
//! by while codeg was not running (or the machine slept) fires once when it
//! is back, its card saying how late; a repeating one fires its latest
//! time and goes on from there — the times before are not sent one by one.
//! A repeating matter whose next time comes while its card is still open
//! fires again, and the old card expires.
//!
//! **The owner's acts.** Done, dropped, put off (`15m`, `1h`, tomorrow
//! morning, a time) or set aside: from the matters panel, a button on the
//! assistant's card, or the reminder card. None of it goes through the
//! brain; the assistant reads a line about it with its next delivery. Done
//! on a repeating matter is done for this time: the next is set. On the
//! reminder card, [Hand to the assistant] is the owner's message quoting
//! it.
//!
//! **The owner's zone** is their preference (`system` follows the
//! system's). When it changes — they set another, or the laptop they
//! follow travels — a repeating matter's next time moves to keep its
//! wall-clock time in the new zone (1.12), unless it was put off to a
//! moment of its own; a one-off is a moment and stays.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use serde_json::{json, Value};

use super::clock;
use super::due::{self, ActSpec, AtDue, Mornings, Repeat};
use super::engine::PersonalAgentEngine;
use crate::db::entities::personal_agent_item::{
    self as item_entity, ItemKind, ItemStatus, WaitsFor,
};
use crate::db::entities::personal_agent_notice::{
    self as notice_entity, NoticeKind, NoticeLevel, NoticeState,
};
use crate::db::entities::personal_agent_timeline::TimelineKind;
use super::refusal::{keys, Refusal};
use crate::db::service::personal_agent_matter_service as matter_svc;
use crate::db::service::personal_agent_message_service as msvc;
use crate::db::service::personal_agent_service::{
    self as svc, ItemFire, ItemTime, ItemWrite, Lineage, NewEvent, NewNotice, NewRow,
};
use crate::models::personal_agent::{PersonalAgentChange, TimelineRow};

/// How often the clock looks (4.1).
pub const DUE_TICK: std::time::Duration = std::time::Duration::from_secs(15);

/// The event kind that wakes an assistant for a matter it is to do.
pub const REMINDER_EVENT: &str = "reminder";
/// The event kind of a line about a matter the assistant reads with its
/// next delivery: the owner was reminded, or settled it.
pub const ITEM_NOTE_EVENT: &str = "item_note";

/// What the owner does about a matter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ItemOp {
    Done,
    /// A repeating matter's this time passed over: on to its next, by its
    /// rule; the last time skipped ends it (`skipped`).
    Skip,
    Drop,
    /// Set aside, to wait with no time.
    Later,
    /// Put off until then.
    Snooze(DateTime<Utc>),
}

impl ItemOp {
    /// An act as the page names it: `done`, `skip`, `drop`, `later`,
    /// `snooze` (with `until`: `15m`, `1h`, `tomorrow`, a time; without,
    /// `later`).
    pub fn parse(
        act: &str,
        until: Option<&str>,
        tz: Tz,
        now: DateTime<Utc>,
        mornings: Mornings,
    ) -> Result<Self, String> {
        match (act, until.map(str::trim).filter(|u| !u.is_empty())) {
            ("done", _) => Ok(ItemOp::Done),
            ("skip", _) => Ok(ItemOp::Skip),
            ("drop", _) => Ok(ItemOp::Drop),
            ("later", None) | ("snooze", None) => Ok(ItemOp::Later),
            ("snooze", Some(u)) | ("later", Some(u)) => {
                if u.chars().count() > 64 {
                    return Err("`until` is too long".into());
                }
                let t = due::parse_when(u, tz, now, mornings)?;
                due::check_due(t, tz, now)?;
                Ok(ItemOp::Snooze(t))
            }
            (other, _) => Err(format!("unknown act `{other}`")),
        }
    }
}

/// Where the owner acted on a matter from. Only the panel's acts are taken
/// back: a card keeps its press on its own row, which an undo of the matter
/// would leave behind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpSource {
    /// The activity panel's buttons.
    Panel,
    /// A button on a card the assistant drew (`pa.item`).
    AssistantCard,
    /// A reminder card in the conversation.
    ReminderCard,
    /// A card one of codeg's rules raised (an idle matter).
    RuleCard,
}

impl OpSource {
    pub fn as_str(self) -> &'static str {
        match self {
            OpSource::Panel => "panel",
            OpSource::AssistantCard => "assistant_card",
            OpSource::ReminderCard => "reminder_card",
            OpSource::RuleCard => "rule_card",
        }
    }

    /// As the page names it: `card` (the assistant's), else the panel.
    pub fn from_page(from: Option<&str>) -> Self {
        match from {
            Some("card") => OpSource::AssistantCard,
            _ => OpSource::Panel,
        }
    }
}

/// What the owner's act on a matter left.
#[derive(Debug, Clone)]
pub struct ItemActed {
    pub item: item_entity::Model,
    /// What takes it back (`undo_item`): the panel's acts only.
    pub undo: Option<i32>,
    /// A message matter dropped: whether its message was taken back.
    pub withdrawn: Option<bool>,
}

/// A matter's time, in the words its lines and tool answers give it:
/// `due 2026-11-12 15:00 Thu (tomorrow) · reminds the owner · every day at
/// 09:00 · fired`.
pub fn time_words(item: &item_entity::Model, tz: Tz, now: DateTime<Utc>) -> Option<String> {
    let due_at = item.due_at?;
    let mut out = format!("due {}", due::describe(due_at, tz, now));
    out.push_str(match AtDue::parse(item.at_due.as_deref()) {
        Some(AtDue::Act) => " · wakes you to do it",
        _ => " · reminds the owner",
    });
    if let Some(rule) = Repeat::parse(item.repeat.as_deref()) {
        out.push_str(&format!(" · {}", due::describe_repeat(&rule)));
    }
    if item.fired_at.is_some_and(|f| f >= due_at) {
        out.push_str(" · fired");
    } else if due_at <= now {
        out.push_str(" · overdue");
    }
    Some(out)
}

/// The next times of a matter, for the assistant to check what it set:
/// its due time and the rule's two after it.
pub fn next_times(time: &ItemTime, tz: Tz, now: DateTime<Utc>) -> Vec<String> {
    let Some(first) = time.due_at else {
        return Vec::new();
    };
    let mut out = vec![due::describe(first, tz, now)];
    if let Some(rule) = Repeat::parse(time.repeat.as_deref()) {
        let mut t = first;
        for _ in 0..2 {
            match due::next_after(&rule, tz, t) {
                Some(n) => {
                    out.push(due::describe(n, tz, now));
                    t = n;
                }
                None => break,
            }
        }
    }
    out
}

/// A repeat rule as stored, its next time now set in `tz` (1.12): the
/// rule's own, or a `moment` of its own.
fn placed(repeat: Option<&str>, tz: Tz, moment: bool) -> Option<String> {
    let rule = Repeat::parse(repeat)?.placed(tz, moment);
    serde_json::to_string(&rule).ok()
}

/// A repeating matter's time after it is done once: its next. `None` for
/// one that does not repeat, or whose rule has ended — it is done.
pub fn after_done(item: &item_entity::Model, tz: Tz, now: DateTime<Utc>) -> Option<ItemTime> {
    let rule = Repeat::parse(item.repeat.as_deref())?;
    let next = due::next_after(&rule, tz, item.due_at?.max(now))?;
    Some(
        ItemTime {
            repeat: placed(item.repeat.as_deref(), tz, false),
            ..ItemTime::of(item)
        }
        .at(next),
    )
}

/// A matter's time as `item_update`'s arguments set it (`due`, `repeat`,
/// `at_due`, `act_spec`, `clear_due`), on `item` as it is (none for a new
/// one): `None` when they leave it alone. A new `due` alone moves the next
/// time only — a repeating matter keeps its rule; `repeat: { "every":
/// "none" }` ends one. An `act_spec` makes it one the assistant is to do.
pub fn time_from_args(
    args: &Value,
    item: Option<&item_entity::Model>,
    tz: Tz,
    now: DateTime<Utc>,
    mornings: Mornings,
) -> Result<Option<ItemTime>, String> {
    let given = |k: &str| args.get(k).filter(|v| !v.is_null());
    let clear = given("clear_due").and_then(Value::as_bool).unwrap_or(false);
    let due_arg = given("due")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let repeat_arg = given("repeat");
    let at_due_arg = given("at_due").and_then(Value::as_str);
    let spec_arg = given("act_spec");
    let any =
        due_arg.is_some() || repeat_arg.is_some() || at_due_arg.is_some() || spec_arg.is_some();
    if clear {
        if any {
            return Err(
                "`clear_due` takes the time away: give it alone, or give a new `due` instead"
                    .into(),
            );
        }
        return Ok(Some(ItemTime::none()));
    }
    if !any {
        return Ok(None);
    }
    if let Some(i) = item {
        if matches!(i.kind, ItemKind::Dispatch | ItemKind::Message) {
            return Err(
                "a dispatch's matter follows its work and a message's waits for its answer: \
                 neither takes a time — add a reminder of its own"
                    .into(),
            );
        }
    }
    let at_due = match at_due_arg {
        Some("notify") => AtDue::Notify,
        Some("act") => AtDue::Act,
        Some(_) => return Err("`at_due` must be notify or act".into()),
        None if spec_arg.is_some() => AtDue::Act,
        None => item
            .and_then(|i| AtDue::parse(i.at_due.as_deref()))
            .unwrap_or(AtDue::Notify),
    };
    let new_due = match due_arg {
        Some(s) => {
            let t = due::parse_when(s, tz, now, mornings)?;
            due::check_due(t, tz, now)?;
            Some(t)
        }
        None => None,
    };
    let Some(due_at) = new_due.or(item.and_then(|i| i.due_at)) else {
        return Err("a time needs `due`: when it is — the first time, for a repeating one".into());
    };
    let first = due_at.with_timezone(&tz).naive_local();
    let repeat = match repeat_arg {
        Some(Value::String(s)) if s == "none" => None,
        Some(v) if v.get("every").and_then(Value::as_str) == Some("none") => None,
        // A rule from its first time: that time is the rule's.
        Some(v) => Some(
            serde_json::to_string(&due::parse_repeat(v, first)?.placed(tz, false))
                .map_err(|e| e.to_string())?,
        ),
        // The next time alone, moved: a moment of its own.
        None if new_due.is_some() => item.and_then(|i| placed(i.repeat.as_deref(), tz, true)),
        None => item.and_then(|i| i.repeat.clone()),
    };
    let act_spec = match spec_arg {
        Some(v) => {
            Some(serde_json::to_string(&due::parse_act_spec(v)?).map_err(|e| e.to_string())?)
        }
        None => item.and_then(|i| i.act_spec.clone()),
    };
    // The same time, changed otherwise: as fired as the clock has it.
    Ok(Some(ItemTime {
        due_at: Some(due_at),
        repeat,
        at_due: Some(at_due.as_str().to_string()),
        act_spec,
        fresh: new_due.is_some() || item.is_none(),
    }))
}

fn quoted(summary: &str) -> String {
    let s: String = summary.chars().take(120).collect();
    format!("\"{s}\"")
}

/// What "tomorrow morning" is for the owner: when their day usually starts
/// (1.12), or the fixed time they set (1.13).
pub(super) async fn mornings_of(
    db: &sea_orm::DatabaseConnection,
    prefs: &crate::models::personal_agent_prefs::Prefs,
) -> Mornings {
    use crate::models::personal_agent_prefs::{clock_of, MorningMode};
    match prefs.morning {
        MorningMode::Fixed => {
            let at = clock_of(&prefs.morning_at).unwrap_or_else(|| Mornings::default().workday);
            Mornings {
                workday: at,
                restday: at,
            }
        }
        MorningMode::Hours => super::presence::hours(db, prefs, clock::now())
            .await
            .mornings(),
    }
}

impl PersonalAgentEngine {
    /// The owner's zone, for every time an assistant reads or writes.
    pub(super) async fn owner_tz(&self) -> Tz {
        clock::zone_of(&self.prefs().await.time_zone)
    }

    /// The owner's zone, and when their day starts ("tomorrow morning").
    pub(super) async fn owner_day(&self) -> (Tz, Mornings) {
        let prefs = self.prefs().await;
        let tz = clock::zone_of(&prefs.time_zone);
        (tz, mornings_of(&self.db.conn, &prefs).await)
    }

    /// The `<codeg-now>` line of a turn: now, the owner (whether they are
    /// in codeg, their usual hours), their last message before
    /// `before_row` (all of them, `None`), and what started it.
    pub(super) async fn now_line(&self, before_row: Option<i32>, started_by: &str) -> String {
        let prefs = self.prefs().await;
        let tz = clock::zone_of(&prefs.time_zone);
        let now = clock::now();
        let hours = super::presence::hours(&self.db.conn, &prefs, now).await;
        let about = super::presence::about_owner(&super::presence::now_state(), &hours, tz, now);
        let last = svc::last_owner_message_before(&self.db.conn, self.bot().await, before_row)
            .await
            .ok()
            .flatten();
        due::now_line(now, tz, &about, last, started_by)
    }

    /// The clock's look at this assistant's matters (`DUE_TICK`).
    pub(super) async fn due_tick(self: &Arc<Self>) {
        let now = clock::now();
        self.fire_due_at(now).await;
        // The routines run on the same clock (6.9), off its loop.
        self.spawn_routine_tick(now);
    }

    /// Fire this assistant's matters due by `now` — the clock's look, at a
    /// time a test sets.
    pub(crate) async fn fire_due_at(&self, now: DateTime<Utc>) {
        let bot = self.bot().await;
        if bot <= 0 {
            return;
        }
        let tz = self.owner_tz().await;
        let was = {
            let mut zone = self.clock_zone.lock().unwrap_or_else(|e| e.into_inner());
            zone.replace(tz)
        };
        self.follow_zone(bot, was, tz, now).await;
        let Ok(items) = svc::due_items(&self.db.conn, bot, now).await else {
            return;
        };
        let mut woke = false;
        for item in items {
            match self.fire_one(&item, tz, now).await {
                Ok(Some(AtDue::Act)) => woke = true,
                Ok(_) => {}
                Err(e) => tracing::warn!("[personal_agent] matter #{} did not fire: {e}", item.id),
            }
        }
        if woke {
            self.nudge();
        }
    }

    /// Each repeating matter waiting for its next time in a zone that is no
    /// longer the owner's (`tz`) keeps its wall-clock time in theirs: the
    /// zone its time was set in is on its rule — or, for one set before
    /// rules kept it, `was`, the zone this engine last saw. One whose next
    /// time is a moment of its own (put off, moved) keeps it — so does one
    /// set before rules kept that, whose time is not the rule's clock time;
    /// one whose time in the new zone has gone by today takes its next.
    /// Either way its rule then names the owner's zone.
    async fn follow_zone(&self, bot: i32, was: Option<Tz>, tz: Tz, now: DateTime<Utc>) {
        let Ok(items) = svc::repeating_items(&self.db.conn, bot, now).await else {
            return;
        };
        for item in items {
            let (Some(due_at), Some(rule)) = (item.due_at, Repeat::parse(item.repeat.as_deref()))
            else {
                continue;
            };
            let set_in = match rule.zone.as_deref() {
                Some(z) if z == tz.name() => continue,
                Some(z) => z.parse::<Tz>().ok(),
                None => was,
            };
            let mut time = ItemTime {
                repeat: placed(item.repeat.as_deref(), tz, rule.moment),
                ..ItemTime::of(&item)
            };
            let local = set_in
                .filter(|_| !rule.moment)
                .map(|z| due_at.with_timezone(&z).naive_local());
            if let Some(local) = local.filter(|l| l.time() == rule.time()) {
                let mut to = due::local_at(tz, local.date().and_time(rule.time()));
                if to <= now {
                    to = due::next_after(&rule, tz, now).unwrap_or(due_at);
                }
                if to != due_at {
                    time = time.at(to);
                }
            }
            let moved = time.fresh;
            let write = ItemWrite {
                time: Some(time),
                ..Default::default()
            };
            match svc::update_item_with(
                &self.db.conn,
                bot,
                item.id,
                svc::ItemChange {
                    write,
                    expect_due: Some(Some(due_at)),
                    ..Default::default()
                },
            )
            .await
            {
                Ok(Some(c)) if moved => self.emit_item(c.item.id),
                Ok(_) => {}
                Err(e) => tracing::warn!(
                    "[personal_agent] matter #{} kept its time in the old zone: {e}",
                    item.id
                ),
            }
        }
    }

    /// Fire one matter due by `now`, unless it fired for this time already
    /// (a one-off waits for the owner; a repeating one fires again once
    /// its next time has come). What fired, if it did.
    async fn fire_one(
        &self,
        item: &item_entity::Model,
        tz: Tz,
        now: DateTime<Utc>,
    ) -> Result<Option<AtDue>, String> {
        let Some(due_at) = item.due_at else {
            return Ok(None);
        };
        if matches!(item.kind, ItemKind::Dispatch | ItemKind::Message) {
            return Ok(None);
        }
        let at_due = AtDue::parse(item.at_due.as_deref()).unwrap_or(AtDue::Notify);
        let rule = Repeat::parse(item.repeat.as_deref());
        let from = if item.fired_at.is_some_and(|f| f >= due_at) {
            let Some(rule) = rule.as_ref() else {
                return Ok(None);
            };
            match due::next_after(rule, tz, due_at) {
                Some(n) if n <= now => n,
                _ => return Ok(None),
            }
        } else {
            due_at
        };
        let (occ, missed) = due::catch_up(rule.as_ref(), tz, from, now);
        let late = (now - occ).num_seconds();
        let late_secs = if late >= due::LATE_AFTER_SECS {
            late
        } else {
            0
        };
        let when = due::describe(occ, tz, now);
        let late_words = if late_secs > 0 {
            format!(
                ", {} late — codeg was not running, or the computer slept, at that time",
                due::span(chrono::Duration::seconds(late_secs))
            )
        } else {
            String::new()
        };
        let missed_words = if missed > 0 {
            format!(" ({missed} earlier time(s) went by meanwhile and were not sent)")
        } else {
            String::new()
        };
        let repeat_value = rule
            .as_ref()
            .and_then(|r| serde_json::to_value(r).ok())
            .unwrap_or(Value::Null);
        let mut data = json!({
            "notice": "reminder",
            "state": "open",
            "item_id": item.id,
            "summary": item.summary,
            "at_due": at_due.as_str(),
            "due_at": occ,
            "late_secs": late_secs,
            "missed": missed,
            "repeat": repeat_value,
        });
        let origin = item
            .origin_timeline_id
            .map(|id| format!(" (set from #{id})"))
            .unwrap_or_default();
        let fired_ms = now.timestamp_millis();
        let (event, body, state, waits_for) = match at_due {
            AtDue::Notify => (
                NewEvent {
                    kind: ITEM_NOTE_EVENT.into(),
                    source_key: format!("reminder:{}:{fired_ms}", item.id),
                    coalesce_key: None,
                    summary: format!(
                        "Reminder #{} {} was shown to the owner, due {when}{late_words}{missed_words}.",
                        item.id,
                        quoted(&item.summary)
                    ),
                    payload: Some(json!({ "item_id": item.id, "due_at": occ })),
                    wake: false,
                    lineage: Lineage::default(),
                },
                format!("Reminder #{}: {} (due {when}{late_words})", item.id, item.summary),
                NoticeState::Open,
                Some(WaitsFor::Owner),
            ),
            AtDue::Act => {
                data["state"] = "woke".into();
                let spec = ActSpec::parse(item.act_spec.as_deref());
                let what = spec
                    .as_ref()
                    .map(|s| s.what.trim().to_string())
                    .filter(|w| !w.is_empty())
                    .unwrap_or_else(|| item.summary.clone());
                let draft = spec
                    .as_ref()
                    .and_then(|s| s.dispatch.as_ref())
                    .map(|d| format!(" The dispatch you drafted for it: {}.", Value::Object(d.clone())))
                    .unwrap_or_default();
                (
                    NewEvent {
                        kind: REMINDER_EVENT.into(),
                        source_key: format!("reminder:{}:{fired_ms}", item.id),
                        coalesce_key: None,
                        summary: format!(
                            "It is time for #{} {} — you told the owner you would do it at {when}{origin}{late_words}{missed_words}. \
                             What you are to do: {what}.{draft} Do it now as your settings allow, tell the owner, and mark \
                             #{} done with item_update when it is.",
                            item.id,
                            quoted(&item.summary),
                            item.id
                        ),
                        payload: Some(json!({
                            "item_id": item.id,
                            "due_at": occ,
                            "act_spec": spec.as_ref().and_then(|s| serde_json::to_value(s).ok()),
                        })),
                        wake: true,
                        lineage: Lineage::default(),
                    },
                    format!("Due now, for you to do — #{}: {} (due {when}{late_words})", item.id, item.summary),
                    NoticeState::Acted,
                    Some(WaitsFor::Agent),
                )
            }
        };
        let mut row = NewRow::new(TimelineKind::Notice, body);
        row.segment_id = self.state.lock().await.connection_segment;
        row.data = Some(data);
        let fired = svc::fire_item(
            &self.db.conn,
            self.bot().await,
            ItemFire {
                item_id: item.id,
                seen_due: due_at,
                seen_fired: item.fired_at,
                due_at: occ,
                fired_at: now,
                waits_for,
                notice: NewNotice {
                    kind: NoticeKind::Reminder,
                    subject_key: Some(svc::reminder_subject(item.id)),
                    level: match at_due {
                        AtDue::Notify => NoticeLevel::Urgent,
                        AtDue::Act => NoticeLevel::Normal,
                    },
                    batch_id: None,
                    payload: json!({ "item_id": item.id, "due_at": occ, "at_due": at_due.as_str() }),
                },
                notice_state: state,
                row,
                event_numbers_row: at_due == AtDue::Act,
                event,
            },
        )
        .await
        .map_err(|e| e.to_string())?;
        let Some(fired) = fired else {
            // Changed meanwhile: the next look reads it as it is now.
            return Ok(None);
        };
        let card_id = fired.row.id;
        let mut rows = vec![svc::to_row(fired.row)];
        for old in &fired.expired {
            if let Ok(r) = self.set_reminder_row(old, "expired", None, None).await {
                rows.push(r);
            }
        }
        self.emit_rows(rows);
        self.emit(PersonalAgentChange::Item { id: item.id });
        self.emit(PersonalAgentChange::Status);
        // The owner's reminder reaches them (1.13); one the assistant is to
        // do wakes it instead.
        if let (AtDue::Notify, Some(host)) = (at_due, self.host_ref()) {
            let bot = self.bot().await;
            host.tell(super::reach::News {
                key: format!("reminder:{}:{}", item.id, occ.timestamp()),
                bot_id: bot,
                kind: "reminder",
                what: super::reach::What::Reminder {
                    text: super::reach::glimpse(&item.summary),
                    at: occ.with_timezone(&tz).format("%H:%M").to_string(),
                },
                link: Some(super::reach::NotifyLink::Bot {
                    bot_id: bot,
                    row_id: Some(card_id),
                }),
                need: None,
            })
            .await;
        }
        Ok(Some(at_due))
    }

    /// Write a reminder card's state on its row (and when it was put off
    /// to), and show it.
    async fn set_reminder_row(
        &self,
        notice: &notice_entity::Model,
        state: &str,
        until: Option<DateTime<Utc>>,
        error: Option<&Refusal>,
    ) -> Result<TimelineRow, String> {
        let id = notice.timeline_id.ok_or("the card's row is missing")?;
        let row = svc::get_row(&self.db.conn, id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("the card's row is missing")?;
        let data = Self::reminder_data(&row, state, until, error);
        svc::update_row_data(&self.db.conn, id, None, Some(data))
            .await
            .map_err(|e| e.to_string())?;
        let updated = svc::get_row(&self.db.conn, id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("the card's row is missing")?;
        let row = svc::to_row(updated);
        self.emit_rows(vec![row.clone()]);
        Ok(row)
    }

    fn reminder_data(
        row: &crate::db::entities::personal_agent_timeline::Model,
        state: &str,
        until: Option<DateTime<Utc>>,
        error: Option<&Refusal>,
    ) -> Value {
        let mut data = row
            .data
            .as_deref()
            .and_then(|d| serde_json::from_str::<Value>(d).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}));
        data["state"] = state.into();
        data["until"] = until.map(|u| json!(u)).unwrap_or(Value::Null);
        // What went wrong, in English and as the page words it.
        data["error"] = error.map(|e| Value::from(e.message.clone())).unwrap_or(Value::Null);
        data["error_key"] = error.and_then(|e| e.key).map(Value::from).unwrap_or(Value::Null);
        data["error_params"] = error
            .filter(|e| e.key.is_some() && !e.params.is_empty())
            .map(|e| json!(e.params))
            .unwrap_or(Value::Null);
        data
    }

    /// Change one of this assistant's matters in one transaction with its
    /// open reminder cards (closed as `card` says) and the line the
    /// assistant reads about it (`note`), and show what changed. A change
    /// of its time is made only if its due time is still the one it was
    /// worked out from (`seen`): one the clock moved meanwhile is refused.
    pub(super) async fn write_item(
        &self,
        item: &item_entity::Model,
        write: ItemWrite,
        card: Option<(&str, Option<DateTime<Utc>>)>,
        note: Option<String>,
    ) -> Result<item_entity::Model, String> {
        let expect_due = write.time.is_some().then_some(item.due_at);
        let changed = svc::update_item_with(
            &self.db.conn,
            self.bot().await,
            item.id,
            svc::ItemChange {
                write,
                expect_due,
                close: card.map(|(state, until)| Self::card_close(state, until)),
                note: note.map(|n| Self::item_note(item.id, n)),
                ..Default::default()
            },
        )
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| {
            format!(
                "matter #{} changed meanwhile (its time came, or it was changed elsewhere): look at it again",
                item.id
            )
        })?;
        self.emit_rows(changed.rows.into_iter().map(svc::to_row).collect());
        self.emit_item(item.id);
        self.emit(PersonalAgentChange::Status);
        Ok(changed.item)
    }

    /// What the owner does about one of its matters, without the brain
    /// (6.1): from the matters panel, a card's button or a reminder card
    /// (`source`). The assistant reads a line about it with its next
    /// delivery. Handed-out work settles with the work. Made only on the
    /// matter as it was read: one that changed meanwhile is refused, so
    /// what takes it back (`undo`, the panel's alone) never puts back an
    /// older version.
    pub async fn item_op(
        &self,
        item_id: i32,
        op: ItemOp,
        source: OpSource,
    ) -> Result<ItemActed, Refusal> {
        self.item_op_seen(item_id, op, source, None).await
    }

    /// [`Self::item_op`], from a button that read the matter at `seen` (its
    /// `updated_at`): refused (`changed`) when it was written since — a
    /// stale button never acts on the matter as it is now (a repeating
    /// one's next time skipped too).
    pub async fn item_op_seen(
        &self,
        item_id: i32,
        op: ItemOp,
        source: OpSource,
        seen: Option<DateTime<Utc>>,
    ) -> Result<ItemActed, Refusal> {
        let bot = self.bot().await;
        let item = svc::get_item_of(&self.db.conn, bot, item_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| Refusal::new(keys::GONE, format!("no matter #{item_id}")))?;
        if seen.is_some_and(|s| s != item.updated_at) {
            return Err(Self::changed_since_seen(item_id));
        }
        let timed = matches!(op, ItemOp::Later | ItemOp::Snooze(_));
        // Handed-out work settles itself as the work ends — except a pull
        // request codeg does not follow yet (8.5): the owner closes that
        // one once it is merged, or drops it.
        if item.kind == ItemKind::Dispatch {
            let live = match item.dispatch_id {
                Some(id) => svc::get_dispatch(&self.db.conn, id)
                    .await
                    .map_err(|e| e.to_string())?
                    .is_some_and(|d| super::dispatch::LIVE_STATES.contains(&d.state)),
                None => false,
            };
            if live {
                return Err(Refusal::new(
                    keys::WORK_RUNNING,
                    "a piece of handed-out work is settled when the work ends; stop it on its card",
                ));
            }
            if timed {
                return Err(Refusal::new(
                    keys::WORK_NO_TIME,
                    "a piece of handed-out work is settled when the work ends, not put off to a time",
                ));
            }
        }
        let message = match item.kind {
            ItemKind::Message => self.message_of_item(&item).await,
            _ => None,
        };
        if item.kind == ItemKind::Message && timed {
            let peer = match &message {
                Some(m) => self.bot_name_of(m.to_bot_id).await,
                None => String::new(),
            };
            return Err(Refusal::new(
                keys::MESSAGE_NO_TIME,
                "a message waits for its answer, not for a time",
            )
            .with("peer", peer));
        }
        if item.kind == ItemKind::WhenMentioned && timed {
            return Err(Refusal::new(
                keys::MENTION_NO_TIME,
                "a reminder on a mention comes up when it is mentioned, not at a time",
            ));
        }
        if matches!(item.status, ItemStatus::Done | ItemStatus::Dropped) {
            return Err(Refusal::new(
                keys::SETTLED,
                format!("matter #{item_id} is already settled"),
            ));
        }
        let tz = self.owner_tz().await;
        let now = clock::now();
        // Someone else has it: no time to wait for.
        if timed && item.waits_for == Some(WaitsFor::External) {
            return Err(Refusal::new(
                keys::WAITS_OUTSIDE,
                "this matter waits on something outside codeg, not for a time",
            ));
        }
        if timed && item.waits_for == Some(WaitsFor::Agent) {
            return Err(Refusal::new(
                keys::IN_OTHER_HANDS,
                "this matter is in someone else's hands, not waiting for a time",
            )
            .with("bot", self.bot_name_of(bot).await));
        }
        // Only a repeating matter has a "this time" to skip.
        if op == ItemOp::Skip && item.repeat.is_none() {
            return Err(Refusal::new(
                keys::SKIP_NOT_REPEATING,
                "only a repeating matter can skip a time",
            ));
        }
        // A time still ahead: putting it off moves it later, never sooner;
        // with no time is not "later" for it.
        let ahead = item
            .due_at
            .filter(|d| *d > now && !item.fired_at.is_some_and(|f| f >= *d));
        match (&op, ahead) {
            (ItemOp::Snooze(t), Some(d)) if *t < d => {
                return Err(Refusal::new(
                    keys::NOT_EARLIER,
                    format!(
                        "it comes up {} already: putting it off moves it later",
                        due::describe(d, tz, now)
                    ),
                )
                .at("when", d));
            }
            (ItemOp::Later, Some(d)) => {
                return Err(Refusal::new(
                    keys::HAS_TIME,
                    format!("it is set for {} already", due::describe(d, tz, now)),
                )
                .at("when", d));
            }
            _ => {}
        }
        let name = quoted(&item.summary);
        let owner = |how| Some(svc::Closing::new(svc::Closer::Owner, how));
        let (write, card, until, note, op_name) = match &op {
            ItemOp::Done => match after_done(&item, tz, now) {
                Some(next) => {
                    let when = next
                        .due_at
                        .map(|t| due::describe(t, tz, now))
                        .unwrap_or_default();
                    (
                        ItemWrite {
                            waits_for: Some(Some(WaitsFor::Time)),
                            time: Some(next),
                            ..Default::default()
                        },
                        "done",
                        None,
                        format!("The owner marked #{item_id} {name} done for this time; it comes up next {when}."),
                        "done",
                    )
                }
                None => (
                    ItemWrite {
                        status: Some(ItemStatus::Done),
                        closing: owner("done"),
                        ..Default::default()
                    },
                    "done",
                    None,
                    format!("The owner marked #{item_id} {name} done."),
                    "done",
                ),
            },
            ItemOp::Skip => match after_done(&item, tz, now) {
                Some(next) => {
                    let when = next
                        .due_at
                        .map(|t| due::describe(t, tz, now))
                        .unwrap_or_default();
                    (
                        ItemWrite {
                            waits_for: Some(Some(WaitsFor::Time)),
                            time: Some(next),
                            ..Default::default()
                        },
                        "done",
                        None,
                        format!("The owner skipped #{item_id} {name} this time; it comes up next {when}."),
                        "skip",
                    )
                }
                None => (
                    ItemWrite {
                        status: Some(ItemStatus::Done),
                        closing: owner("skipped"),
                        ..Default::default()
                    },
                    "done",
                    None,
                    format!("The owner skipped the last time of #{item_id} {name}; it is over."),
                    "skip",
                ),
            },
            ItemOp::Drop => (
                ItemWrite {
                    status: Some(ItemStatus::Dropped),
                    closing: owner("dropped"),
                    ..Default::default()
                },
                "dropped",
                None,
                format!("The owner dropped #{item_id} {name}."),
                "drop",
            ),
            ItemOp::Later => {
                // A one-off that already came due waits with no time now;
                // a repeating one keeps its rule.
                let came = item
                    .due_at
                    .is_some_and(|d| d <= now || item.fired_at.is_some_and(|f| f >= d));
                let clear = came && item.repeat.is_none();
                (
                    ItemWrite {
                        waits_for: Some(Some(WaitsFor::Time)),
                        time: clear.then(ItemTime::none),
                        ..Default::default()
                    },
                    "closed",
                    None,
                    format!("The owner set #{item_id} {name} aside, to wait with no time."),
                    "later",
                )
            }
            ItemOp::Snooze(t) => (
                ItemWrite {
                    waits_for: Some(Some(WaitsFor::Time)),
                    time: Some(
                        ItemTime {
                            at_due: Some(item.at_due.clone().unwrap_or_else(|| "notify".into())),
                            // A moment of its own: a change of zone leaves it.
                            repeat: placed(item.repeat.as_deref(), tz, true)
                                .or_else(|| item.repeat.clone()),
                            ..ItemTime::of(&item)
                        }
                        .at(*t),
                    ),
                    ..Default::default()
                },
                "snoozed",
                Some(*t),
                format!(
                    "The owner put #{item_id} {name} off until {}.",
                    due::describe(*t, tz, now)
                ),
                "snooze",
            ),
        };
        // Dropped, a message the matter waits on is taken back with it
        // when its receiver has not started on it.
        let withdraw = match (&op, &message) {
            (ItemOp::Drop, Some(m)) if msvc::LIVE_MESSAGE_STATES.contains(&m.state) => {
                let peer = self.bot_name_of(m.to_bot_id).await;
                Some(svc::Withdraw {
                    message_id: m.id,
                    to_bot: m.to_bot_id,
                    withdrawn: (
                        svc::Closing::new(svc::Closer::Owner, "withdrawn"),
                        format!(
                            "The owner dropped #{item_id} {name}: the message to {peer} was taken back before they started on it."
                        ),
                    ),
                    kept: (
                        svc::Closing::new(svc::Closer::Owner, "stopped_waiting"),
                        format!(
                            "The owner dropped #{item_id} {name}: the message to {peer} could not be withdrawn (it may have reached them); you no longer wait for its answer."
                        ),
                    ),
                })
            }
            _ => None,
        };
        let close = Self::card_close(card, until);
        let changed = svc::update_item_with(
            &self.db.conn,
            bot,
            item.id,
            svc::ItemChange {
                write,
                expect_due: None,
                expect_updated: Some(item.updated_at),
                close: Some(close),
                note: Some(Self::item_note(item.id, note)),
                undo: Some(svc::UndoDraft {
                    op: op_name,
                    source: source.as_str(),
                    before: item.clone(),
                }),
                withdraw: withdraw.clone(),
            },
        )
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| {
            Refusal::new(
                keys::CHANGED,
                format!(
                    "matter #{item_id} changed meanwhile (its time came, or it was changed elsewhere): look at it again"
                ),
            )
        })?;
        self.emit_rows(changed.rows.into_iter().map(svc::to_row).collect());
        self.emit_item(item.id);
        self.emit(PersonalAgentChange::Status);
        if let Some(w) = &withdraw {
            if changed.withdrawn == Some(true) {
                self.refresh_lines(w.message_id, "stopped").await;
            }
            self.emit_for(w.to_bot, PersonalAgentChange::Status);
        }
        Ok(ItemActed {
            item: changed.item,
            undo: changed.note_id.filter(|_| source == OpSource::Panel),
            withdrawn: changed.withdrawn,
        })
    }

    /// The refusal of a button that read matter `item_id` before its last
    /// write.
    fn changed_since_seen(item_id: i32) -> Refusal {
        Refusal::new(
            keys::CHANGED,
            format!("matter #{item_id} changed since it was shown: look at it again"),
        )
    }

    /// What a matter's open reminder cards close as (`card`'s state).
    fn card_close(card: &str, until: Option<DateTime<Utc>>) -> svc::CardClose {
        svc::CardClose {
            to: match card {
                "expired" => NoticeState::Expired,
                "dropped" | "closed" => NoticeState::Dismissed,
                _ => NoticeState::Acted,
            },
            state: card.to_string(),
            until,
        }
    }

    /// The line the assistant reads about matter `item_id`.
    fn item_note(item_id: i32, summary: String) -> NewEvent {
        NewEvent {
            kind: ITEM_NOTE_EVENT.into(),
            source_key: format!(
                "item_op:{}:{}",
                item_id,
                chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
            ),
            coalesce_key: None,
            summary,
            payload: Some(json!({ "item_id": item_id })),
            wake: false,
            lineage: Lineage::default(),
        }
    }

    /// The message a `message` matter waits for an answer to: the one its
    /// sender's line (its origin) stands for.
    pub(super) async fn message_of_item(
        &self,
        item: &item_entity::Model,
    ) -> Option<crate::db::entities::personal_agent_message::Model> {
        let line = svc::get_row(&self.db.conn, item.origin_timeline_id?)
            .await
            .ok()
            .flatten()?;
        let id = line.ref_id.as_deref()?.strip_prefix('m')?.parse::<i32>().ok()?;
        msvc::get_message(&self.db.conn, id).await.ok().flatten()
    }

    /// An assistant's name as the owner knows it ("" when it has none: the
    /// page words that itself).
    pub(super) async fn bot_name_of(&self, bot: i32) -> String {
        svc::get_bot_any(&self.db.conn, bot)
            .await
            .ok()
            .flatten()
            .map(|b| b.name.trim().to_string())
            .unwrap_or_default()
    }

    /// The owner takes back a change they made on the panel (`undo`, the
    /// token `item_op` gave): the matter as it was, its reminder cards open
    /// again, a message it took back queued again — within ten minutes,
    /// and only while nothing changed since.
    pub async fn undo_item(&self, item_id: i32, undo: i32) -> Result<item_entity::Model, Refusal> {
        let bot = self.bot().await;
        let done = matter_svc::undo_item_op(&self.db.conn, bot, item_id, undo, clock::now())
            .await
            .map_err(|e| e.to_string())?;
        let undone = match done {
            Ok(u) => u,
            Err(why) => return Err(self.undo_refusal(why).await),
        };
        self.emit_rows(undone.rows.into_iter().map(svc::to_row).collect());
        self.emit_item(item_id);
        self.emit(PersonalAgentChange::Status);
        if let Some((message_id, to)) = undone.requeued {
            self.refresh_lines(message_id, "queued").await;
            self.emit_for(to, PersonalAgentChange::Status);
            if let Some(host) = self.host_ref() {
                if let Some(e) = host.engine_for(Some(to)).await {
                    e.nudge();
                }
            }
        }
        Ok(undone.item)
    }

    /// Why an undo was refused, as the owner reads it.
    pub(super) async fn undo_refusal(&self, why: matter_svc::UndoRefused) -> Refusal {
        use matter_svc::UndoRefused as U;
        match why {
            U::None => Refusal::new(keys::UNDO_NONE, "there is nothing to take back"),
            U::Expired => Refusal::new(
                keys::UNDO_EXPIRED,
                "more than ten minutes went by: it can no longer be taken back",
            ),
            U::Fired => Refusal::new(
                keys::UNDO_FIRED,
                "it came up meanwhile: it can no longer be taken back",
            ),
            U::Changed => Refusal::new(
                keys::UNDO_CHANGED,
                "it changed meanwhile: it can no longer be taken back",
            ),
            U::Replied { peer } => Refusal::new(
                keys::UNDO_REPLIED,
                "the answer came meanwhile: it can no longer be taken back",
            )
            .with("peer", self.bot_name_of(peer).await),
            U::PeerGone { peer } => Refusal::new(
                keys::UNDO_PEER_GONE,
                "the assistant it was written to was deleted: it can no longer be taken back",
            )
            .with("peer", self.bot_name_of(peer).await),
            U::AnswerRead => Refusal::new(
                keys::UNDO_ANSWER_READ,
                "the assistant has read the answer: it can no longer be taken back",
            )
            .with("bot", self.bot_name_of(self.bot().await).await),
        }
    }

    /// The owner's answer on a reminder card: `done`; `snooze:15m`,
    /// `snooze:1h`, `snooze:tomorrow`; `hand_over`, their message (`text`)
    /// quoting the card. The first answer wins.
    ///
    /// What the answer does is written before the card is marked: the
    /// matter's change closes its open cards (this one with it), the
    /// owner's message is written together with the card's "handed". A
    /// card whose matter was settled meanwhile — by the panel, the brain,
    /// or an answer cut off by a restart before it marked the card —
    /// closes as the matter stands.
    pub(super) async fn act_on_reminder(
        self: &Arc<Self>,
        notice: &notice_entity::Model,
        action: &str,
        text: Option<String>,
        seen: Option<DateTime<Utc>>,
    ) -> Result<TimelineRow, Refusal> {
        let item_id = serde_json::from_str::<Value>(&notice.payload)
            .ok()
            .and_then(|p| p.get("item_id").and_then(Value::as_i64))
            .and_then(|id| i32::try_from(id).ok())
            .ok_or("the card names no matter")?;
        let (tz, mornings) = self.owner_day().await;
        let now = clock::now();
        let op =
            match action {
                "done" => Some(ItemOp::Done),
                "snooze:15m" | "snooze:1h" | "snooze:tomorrow" => Some(
                    ItemOp::parse("snooze", action.strip_prefix("snooze:"), tz, now, mornings)
                        .map_err(|e| Refusal::new(keys::BAD_TIME, e))?,
                ),
                "hand_over" => None,
                _ => return Err(
                    "`action` must be done, snooze:15m, snooze:1h, snooze:tomorrow or hand_over"
                        .into(),
                ),
            };
        let _guard = self.reminder_lock.lock().await;
        let notice = svc::get_notice(&self.db.conn, notice.id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("no such card")?;
        let card_id = notice.timeline_id.ok_or("the card's row is missing")?;
        let card = svc::get_row(&self.db.conn, card_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("the card's row is missing")?;
        let card_state = card
            .data
            .as_deref()
            .and_then(|d| serde_json::from_str::<Value>(d).ok())
            .and_then(|d| d.get("state").and_then(Value::as_str).map(str::to_string));
        if notice.state != NoticeState::Open || card_state.as_deref() != Some("open") {
            return Err(Refusal::new(
                keys::REMINDER_ANSWERED,
                "this reminder was answered already",
            ));
        }
        let item = svc::get_item_of(&self.db.conn, self.bot().await, item_id)
            .await
            .map_err(|e| e.to_string())?;
        // From a matter's row that read it before its last write: nothing
        // is done — not even the hand-over, which goes out before the
        // matter is written.
        if let (Some(s), Some(i)) = (seen, item.as_ref()) {
            if s != i.updated_at {
                return Err(Self::changed_since_seen(item_id));
            }
        }
        let settled = match item.as_ref().map(|i| i.status) {
            None => Some("closed"),
            Some(ItemStatus::Done) => Some("done"),
            Some(ItemStatus::Dropped) => Some("dropped"),
            _ => None,
        };
        if let Some(state) = settled {
            let to = if state == "done" {
                NoticeState::Acted
            } else {
                NoticeState::Dismissed
            };
            let _ = svc::move_notice(&self.db.conn, notice.id, &[NoticeState::Open], to).await;
            return Ok(self.set_reminder_row(&notice, state, None, None).await?);
        }
        let summary = item.map(|i| i.summary).unwrap_or_default();
        match op {
            Some(op) => {
                // The matter's change closes its open cards, this one too.
                if let Err(e) = self.item_op_seen(item_id, op, OpSource::ReminderCard, seen).await {
                    let _ = self
                        .set_reminder_row(&notice, "open", None, Some(&e))
                        .await;
                    return Err(e);
                }
                let row = svc::get_row(&self.db.conn, card_id)
                    .await
                    .map_err(|e| e.to_string())?
                    .ok_or("the card's row is missing")?;
                Ok(svc::to_row(row))
            }
            None => {
                let text = text
                    .map(|t| t.trim().chars().take(2_000).collect::<String>())
                    .filter(|t| !t.is_empty())
                    .unwrap_or_else(|| format!("Handle this reminder: {summary}"));
                // The message and the card's "handed" are written together.
                let data = Self::reminder_data(&card, "handed", None, None);
                if let Err(e) = self
                    .queue_owner_message(text, Vec::new(), Some(card_id), super::engine::Origin::Written, None, Some(data))
                    .await
                {
                    let e = Refusal::from(e);
                    let _ = self
                        .set_reminder_row(&notice, "open", None, Some(&e))
                        .await;
                    return Err(e);
                }
                let _ = svc::move_notice(
                    &self.db.conn,
                    notice.id,
                    &[NoticeState::Open],
                    NoticeState::Acted,
                )
                .await;
                let _ = svc::update_item(
                    &self.db.conn,
                    item_id,
                    ItemWrite {
                        waits_for: Some(Some(WaitsFor::Agent)),
                        ..Default::default()
                    },
                )
                .await;
                self.emit_item(item_id);
                let row = svc::get_row(&self.db.conn, card_id)
                    .await
                    .map_err(|e| e.to_string())?
                    .ok_or("the card's row is missing")?;
                Ok(svc::to_row(row))
            }
        }
    }
}
