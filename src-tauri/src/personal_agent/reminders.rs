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
    Drop,
    /// Set aside, to wait with no time.
    Later,
    /// Put off until then.
    Snooze(DateTime<Utc>),
}

impl ItemOp {
    /// An act as the page names it: `done`, `drop`, `later`, `snooze` (with
    /// `until`: `15m`, `1h`, `tomorrow`, a time; without, `later`).
    pub fn parse(
        act: &str,
        until: Option<&str>,
        tz: Tz,
        now: DateTime<Utc>,
        mornings: Mornings,
    ) -> Result<Self, String> {
        match (act, until.map(str::trim).filter(|u| !u.is_empty())) {
            ("done", _) => Ok(ItemOp::Done),
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
                write,
                Some(Some(due_at)),
                None,
                None,
            )
            .await
            {
                Ok(Some((m, _))) if moved => self.emit_item(m.id),
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
        error: Option<String>,
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
        error: Option<String>,
    ) -> Value {
        let mut data = row
            .data
            .as_deref()
            .and_then(|d| serde_json::from_str::<Value>(d).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}));
        data["state"] = state.into();
        data["until"] = until.map(|u| json!(u)).unwrap_or(Value::Null);
        data["error"] = error.map(Value::from).unwrap_or(Value::Null);
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
        let close = card.map(|(state, until)| svc::CardClose {
            to: match state {
                "expired" => NoticeState::Expired,
                "dropped" | "closed" => NoticeState::Dismissed,
                _ => NoticeState::Acted,
            },
            state: state.to_string(),
            until,
        });
        let note = note.map(|summary| NewEvent {
            kind: ITEM_NOTE_EVENT.into(),
            source_key: format!(
                "item_op:{}:{}",
                item.id,
                chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
            ),
            coalesce_key: None,
            summary,
            payload: Some(json!({ "item_id": item.id })),
            wake: false,
            lineage: Lineage::default(),
        });
        let (updated, rows) = svc::update_item_with(
            &self.db.conn,
            self.bot().await,
            item.id,
            write,
            expect_due,
            close,
            note,
        )
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| {
            format!(
                "matter #{} changed meanwhile (its time came, or it was changed elsewhere): look at it again",
                item.id
            )
        })?;
        self.emit_rows(rows.into_iter().map(svc::to_row).collect());
        self.emit_item(item.id);
        self.emit(PersonalAgentChange::Status);
        Ok(updated)
    }

    /// What the owner does about one of its matters, without the brain
    /// (6.1): from the matters panel, a card's button or a reminder card.
    /// The assistant reads a line about it with its next delivery.
    /// Handed-out work settles with the work.
    pub async fn item_op(&self, item_id: i32, op: ItemOp) -> Result<item_entity::Model, String> {
        let bot = self.bot().await;
        let item = svc::get_item_of(&self.db.conn, bot, item_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("no matter #{item_id}"))?;
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
            if live || matches!(op, ItemOp::Later | ItemOp::Snooze(_)) {
                return Err(
                    "a piece of handed-out work is settled when the work ends; stop it on its card"
                        .into(),
                );
            }
        }
        if item.kind == ItemKind::Message && matches!(op, ItemOp::Snooze(_)) {
            return Err("a message waits for its answer, not for a time".into());
        }
        if item.kind == ItemKind::WhenMentioned && matches!(op, ItemOp::Later | ItemOp::Snooze(_)) {
            return Err(
                "a reminder on a mention comes up when it is mentioned, not at a time".into(),
            );
        }
        if matches!(item.status, ItemStatus::Done | ItemStatus::Dropped) {
            return Err(format!("matter #{item_id} is already settled"));
        }
        let tz = self.owner_tz().await;
        let now = clock::now();
        let name = quoted(&item.summary);
        let (write, card, until, note) = match &op {
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
                    )
                }
                None => (
                    ItemWrite {
                        status: Some(ItemStatus::Done),
                        ..Default::default()
                    },
                    "done",
                    None,
                    format!("The owner marked #{item_id} {name} done."),
                ),
            },
            ItemOp::Drop => (
                ItemWrite {
                    status: Some(ItemStatus::Dropped),
                    ..Default::default()
                },
                "dropped",
                None,
                format!("The owner dropped #{item_id} {name}."),
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
            ),
        };
        self.write_item(&item, write, Some((card, until)), Some(note))
            .await
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
    ) -> Result<TimelineRow, String> {
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
                "snooze:15m" | "snooze:1h" | "snooze:tomorrow" => Some(ItemOp::parse(
                    "snooze",
                    action.strip_prefix("snooze:"),
                    tz,
                    now,
                    mornings,
                )?),
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
            return Err("this reminder was answered already".into());
        }
        let item = svc::get_item_of(&self.db.conn, self.bot().await, item_id)
            .await
            .map_err(|e| e.to_string())?;
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
            return self.set_reminder_row(&notice, state, None, None).await;
        }
        let summary = item.map(|i| i.summary).unwrap_or_default();
        match op {
            Some(op) => {
                // The matter's change closes its open cards, this one too.
                if let Err(e) = self.item_op(item_id, op).await {
                    let _ = self
                        .set_reminder_row(&notice, "open", None, Some(e.clone()))
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
                    .unwrap_or_else(|| format!("Handle reminder #{item_id}: {summary}"));
                // The message and the card's "handed" are written together.
                let data = Self::reminder_data(&card, "handed", None, None);
                if let Err(e) = self
                    .queue_owner_message(text, Vec::new(), Some(card_id), super::engine::Origin::Written, None, Some(data))
                    .await
                {
                    let _ = self
                        .set_reminder_row(&notice, "open", None, Some(e.clone()))
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
