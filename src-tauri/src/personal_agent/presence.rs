//! Whether the owner is in codeg, and their usual hours (6.2, 5.1, 1.12).
//!
//! **Present.** Every codeg window beats ([`beat`]): whether it has the
//! focus, and how long since the last key or pointer input in it. The owner
//! is present while some window has the focus and saw input within the last
//! [`PRESENT_WITHIN_SECS`]; a window not heard from for [`WINDOW_GONE_SECS`]
//! is gone (closed, crashed, asleep). It is this process's own: the windows
//! of another codeg process on the same data dir beat there. The bus's
//! `UserPromptSent` is not a sign of the owner — codeg's own sends (an
//! assistant's delivery, a kanban task, an automation) raise it too — and a
//! message typed in any session is input in its window anyway.
//!
//! **The record.** With the owner's `presence` preference on (and an
//! assistant set up), each minute present adds one to its five-minute slot
//! of the owner's local day (`personal_agent_activity`), kept
//! [`KEEP_DAYS`] days. Off, nothing is written; whether the owner is
//! present right now is still known as it happens (it decides when to
//! notify them, 1.13) and kept nowhere.
//!
//! **Usual hours.** Learned from the last [`LEARN_DAYS`] days, workdays and
//! rest days (Saturday, Sunday) apart: each day's first and last active
//! slot — a lone minute is noise — and the median across days. A day runs
//! from [`DAY_BREAK_HOUR`]:00 to [`DAY_BREAK_HOUR`]:00, so a late night is
//! the evening's. Until a kind of day has [`MIN_WORKDAYS`] /
//! [`MIN_RESTDAYS`] days with activity — or with the record off — its
//! hours are the defaults, 09:00–18:00.

use std::collections::{BTreeMap, HashMap};
use std::sync::{LazyLock, Mutex};

use chrono::{DateTime, Duration, NaiveDate, NaiveTime, Timelike, Utc};
use chrono_tz::Tz;
use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};

pub use crate::db::service::personal_agent_activity_service::KEEP_DAYS;

use super::clock;
use super::due::{self, Mornings};
use crate::db::service::personal_agent_activity_service as activity;
use crate::db::service::personal_agent_service as svc;
use crate::models::personal_agent_prefs::{AccountView, Prefs};

/// Input this recent, in a window with the focus, is the owner present.
pub const PRESENT_WITHIN_SECS: i64 = 120;
/// A window not heard from this long is gone.
pub const WINDOW_GONE_SECS: i64 = 90;
/// The days the usual hours are learned from.
pub const LEARN_DAYS: i64 = 28;
/// Workdays with activity it takes to learn a workday's hours.
pub const MIN_WORKDAYS: usize = 5;
/// Rest days with activity it takes to learn a rest day's hours.
pub const MIN_RESTDAYS: usize = 3;
/// A day with fewer active minutes says nothing about the owner's hours.
pub const MIN_DAY_MINUTES: u32 = 15;
/// When one day ends and the next begins, for the hours.
pub const DAY_BREAK_HOUR: u32 = 4;
/// The record's slot.
pub const SLOT_MINUTES: u32 = 5;
/// The hours until they are learned.
pub const DEFAULT_START: u32 = 9 * 60;
pub const DEFAULT_END: u32 = 18 * 60;
/// The most windows kept track of; the one heard from longest ago goes.
const MAX_WINDOWS: usize = 64;
/// A window's id is cut to this.
const MAX_WINDOW_ID: usize = 64;
/// An input reported longer ago than this is taken as this long ago.
const MAX_IDLE_MS: u64 = 30 * 24 * 3_600_000;

/// One window's beat, as the page sends it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Beat {
    /// The window, as it names itself (stable while it is open).
    pub window: String,
    pub focused: bool,
    /// Milliseconds since the last key or pointer input while it had the
    /// focus; none yet, `None`.
    #[serde(default)]
    pub idle_ms: Option<u64>,
    /// Milliseconds since the last keystroke into a text field while it
    /// had the focus (1.13): the owner at work on something.
    #[serde(default)]
    pub typed_ms: Option<u64>,
    /// The assistant whose conversation it shows (1.13).
    #[serde(default)]
    pub viewing: Option<i32>,
    /// The session (conversation) its workspace has in front (6.7): a
    /// session waiting on the owner while they are in it is not raised.
    #[serde(default)]
    pub viewing_conversation: Option<i32>,
}

/// Whether the owner is in codeg now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Presence {
    pub present: bool,
    /// Their last input in any window this process has heard of.
    pub last_active: Option<DateTime<Utc>>,
}

struct Window {
    focused: bool,
    last_input: Option<DateTime<Utc>>,
    last_typed: Option<DateTime<Utc>>,
    viewing: Option<i32>,
    viewing_conversation: Option<i32>,
    heard: DateTime<Utc>,
}

/// What reaching the owner goes by (1.13): whether they are here, whether
/// they are typing, whether a codeg window has the focus, and the
/// assistants they are looking at.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Attending {
    pub present: bool,
    /// Their last keystroke into a text field in a window with the focus.
    pub last_typed: Option<DateTime<Utc>>,
    /// Some codeg window has the focus.
    pub window_focused: bool,
    /// The assistants a window with the focus shows, while the owner is
    /// present.
    pub viewing: Vec<i32>,
    /// The sessions a window with the focus has in front, while the owner
    /// is present.
    pub viewing_conversations: Vec<i32>,
}

/// The windows heard from, and the record's bookkeeping.
#[derive(Default)]
pub struct Tracker {
    windows: HashMap<String, Window>,
    last_active: Option<DateTime<Utc>>,
    /// The minute (Unix minutes) last written to the record.
    recorded: Option<i64>,
    /// The local day the record was last pruned on.
    pruned: Option<NaiveDate>,
}

impl Tracker {
    /// Take one window's beat at `now`.
    pub fn beat(&mut self, b: &Beat, now: DateTime<Utc>) {
        self.windows
            .retain(|_, w| (now - w.heard).num_seconds() < WINDOW_GONE_SECS);
        let id: String = b.window.trim().chars().take(MAX_WINDOW_ID).collect();
        if !self.windows.contains_key(&id) && self.windows.len() >= MAX_WINDOWS {
            if let Some(oldest) = self
                .windows
                .iter()
                .min_by_key(|(_, w)| w.heard)
                .map(|(k, _)| k.clone())
            {
                self.windows.remove(&oldest);
            }
        }
        let ago = |ms: u64| now - Duration::milliseconds(ms.min(MAX_IDLE_MS) as i64);
        let input = b.idle_ms.map(ago);
        let typed = b.typed_ms.map(ago);
        let w = self.windows.entry(id).or_insert(Window {
            focused: false,
            last_input: None,
            last_typed: None,
            viewing: None,
            viewing_conversation: None,
            heard: now,
        });
        w.focused = b.focused;
        w.heard = now;
        w.viewing = b.viewing.filter(|id| *id > 0);
        w.viewing_conversation = b.viewing_conversation.filter(|id| *id > 0);
        if let Some(t) = typed {
            w.last_typed = Some(w.last_typed.map_or(t, |had| had.max(t)));
        }
        if let Some(t) = input {
            w.last_input = Some(w.last_input.map_or(t, |had| had.max(t)));
            self.last_active = Some(self.last_active.map_or(t, |had| had.max(t)));
        }
    }

    /// What reaching the owner goes by at `now`.
    pub fn attending(&self, now: DateTime<Utc>) -> Attending {
        let live = |w: &&Window| w.focused && (now - w.heard).num_seconds() < WINDOW_GONE_SECS;
        let present = self.state(now).present;
        let mut viewing: Vec<i32> = if present {
            self.windows
                .values()
                .filter(live)
                .filter_map(|w| w.viewing)
                .collect()
        } else {
            Vec::new()
        };
        viewing.sort_unstable();
        viewing.dedup();
        let mut viewing_conversations: Vec<i32> = if present {
            self.windows
                .values()
                .filter(live)
                .filter_map(|w| w.viewing_conversation)
                .collect()
        } else {
            Vec::new()
        };
        viewing_conversations.sort_unstable();
        viewing_conversations.dedup();
        Attending {
            present,
            last_typed: self
                .windows
                .values()
                .filter(live)
                .filter_map(|w| w.last_typed)
                .max(),
            window_focused: self.windows.values().any(|w| live(&w)),
            viewing,
            viewing_conversations,
        }
    }

    /// Whether the owner is present at `now`.
    pub fn state(&self, now: DateTime<Utc>) -> Presence {
        let present = self.windows.values().any(|w| {
            w.focused
                && (now - w.heard).num_seconds() < WINDOW_GONE_SECS
                && w.last_input
                    .is_some_and(|t| (now - t).num_seconds() < PRESENT_WITHIN_SECS)
        });
        Presence {
            present,
            last_active: self.last_active,
        }
    }

    /// Claim `now`'s minute for the record: true the first time it is
    /// asked while the owner is present.
    fn claim_minute(&mut self, now: DateTime<Utc>) -> bool {
        if !self.state(now).present {
            return false;
        }
        let minute = now.timestamp().div_euclid(60);
        if self.recorded == Some(minute) {
            return false;
        }
        self.recorded = Some(minute);
        true
    }

    /// Claim `day` for pruning: true the first time it is asked.
    fn claim_prune(&mut self, day: NaiveDate) -> bool {
        if self.pruned == Some(day) {
            return false;
        }
        self.pruned = Some(day);
        true
    }
}

static TRACKER: LazyLock<Mutex<Tracker>> = LazyLock::new(Default::default);

fn tracker() -> std::sync::MutexGuard<'static, Tracker> {
    TRACKER.lock().unwrap_or_else(|e| e.into_inner())
}

/// Whether the owner is in codeg now, as this process's windows say.
pub fn now_state() -> Presence {
    tracker().state(clock::now())
}

/// What reaching the owner goes by now, as this process's windows say.
pub fn now_attending() -> Attending {
    tracker().attending(clock::now())
}

/// The account's preferences, from the primary's row; `None` before an
/// assistant is set up.
async fn account_prefs(db: &DatabaseConnection) -> Option<Prefs> {
    let primary = svc::primary_bot(db).await.ok().flatten()?;
    Some(AccountView::from_settings(&primary.settings).prefs)
}

/// One window's beat: whether the owner is present after it. Writes this
/// minute to the record, when the owner keeps one and is present.
pub async fn beat(db: &DatabaseConnection, b: Beat) -> Presence {
    let now = clock::now();
    let (state, record) = {
        let mut t = tracker();
        t.beat(&b, now);
        let record = t.claim_minute(now);
        (t.state(now), record)
    };
    if record {
        record_minute(db, now).await;
    }
    state
}

/// Write `now`'s minute to the record, as the owner's preferences have it.
pub(crate) async fn record_minute(db: &DatabaseConnection, now: DateTime<Utc>) {
    let Some(prefs) = account_prefs(db).await else {
        return;
    };
    let tz = clock::zone_of(&prefs.time_zone);
    let local = now.with_timezone(&tz);
    let day = local.date_naive();
    if tracker().claim_prune(day) {
        if let Err(e) = activity::prune(db, day - Duration::days(KEEP_DAYS)).await {
            tracing::warn!("[personal_agent] the presence record was not pruned: {e}");
        }
    }
    if !prefs.records_presence() {
        return;
    }
    let slot = (local.hour() * 60 + local.minute()) / SLOT_MINUTES;
    if let Err(e) = activity::add_minute(db, day, slot, now).await {
        tracing::warn!("[personal_agent] a present minute was not recorded: {e}");
    }
}

// ── usual hours ─────────────────────────────────────────────────────────────

/// One kind of day's usual hours.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct DayHours {
    /// Minutes after the day's midnight. `end` may pass 24:00: a late
    /// night belongs to its evening.
    pub start: u32,
    pub end: u32,
    /// Known: learned from the record, or set by the owner; else the
    /// defaults.
    pub learned: bool,
    /// The days it was learned from.
    pub days: u32,
    /// The owner set it (2.11): it stands whatever the record says.
    #[serde(default)]
    pub set: bool,
}

impl DayHours {
    fn defaults() -> Self {
        Self {
            start: DEFAULT_START,
            end: DEFAULT_END,
            learned: false,
            days: 0,
            set: false,
        }
    }
}

/// The owner's usual hours.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Hours {
    pub workday: DayHours,
    pub restday: DayHours,
}

impl Default for Hours {
    fn default() -> Self {
        Self {
            workday: DayHours::defaults(),
            restday: DayHours::defaults(),
        }
    }
}

impl Hours {
    /// The hours of `day` (a day as the hours count it: see [`hours_day`]).
    pub fn on(&self, day: NaiveDate) -> &DayHours {
        if due::is_rest_day(day) {
            &self.restday
        } else {
            &self.workday
        }
    }

    /// When the owner's day starts, for "tomorrow morning". A start past
    /// midnight is no morning: the default stands.
    pub fn mornings(&self) -> Mornings {
        let base = Mornings::default();
        let at = |d: &DayHours, fallback: NaiveTime| {
            if d.learned && d.start < 24 * 60 {
                NaiveTime::from_hms_opt(d.start / 60, d.start % 60, 0).unwrap_or(fallback)
            } else {
                fallback
            }
        };
        Mornings {
            workday: at(&self.workday, base.workday),
            restday: at(&self.restday, base.restday),
        }
    }
}

/// The day `now` belongs to, as the hours count days: the calendar day,
/// until [`DAY_BREAK_HOUR`] the one before.
pub fn hours_day(now: DateTime<Utc>, tz: Tz) -> NaiveDate {
    (now.with_timezone(&tz) - Duration::hours(DAY_BREAK_HOUR as i64)).date_naive()
}

fn median(mut v: Vec<u32>) -> u32 {
    v.sort_unstable();
    v[(v.len() - 1) / 2]
}

/// The usual hours from the record's `(local date, slot, minutes)`, as of
/// `today` (see [`hours_day`]; it is not counted — it has not ended).
pub fn learn(rows: &[(NaiveDate, u32, u32)], today: NaiveDate) -> Hours {
    let first = today - Duration::days(LEARN_DAYS);
    let mut days: BTreeMap<NaiveDate, Vec<(u32, u32)>> = BTreeMap::new();
    for &(date, slot, count) in rows {
        if count == 0 || slot >= 24 * 60 / SLOT_MINUTES {
            continue;
        }
        let minute = slot * SLOT_MINUTES;
        let (day, minute) = if minute < DAY_BREAK_HOUR * 60 {
            match date.pred_opt() {
                Some(d) => (d, minute + 24 * 60),
                None => continue,
            }
        } else {
            (date, minute)
        };
        if day < first || day >= today {
            continue;
        }
        days.entry(day).or_default().push((minute, count));
    }
    let mut work: Vec<(u32, u32)> = Vec::new();
    let mut rest: Vec<(u32, u32)> = Vec::new();
    for (day, mut slots) in days {
        slots.sort_unstable();
        let total: u32 = slots.iter().map(|(_, c)| c).sum();
        if total < MIN_DAY_MINUTES {
            continue;
        }
        // A slot counts with two minutes in it, or next to another slot.
        let active: Vec<u32> = slots
            .iter()
            .enumerate()
            .filter(|(i, (m, c))| {
                *c >= 2
                    || (*i > 0 && slots[i - 1].0 + SLOT_MINUTES == *m)
                    || slots.get(i + 1).is_some_and(|n| n.0 == m + SLOT_MINUTES)
            })
            .map(|(_, (m, _))| *m)
            .collect();
        let (Some(&start), Some(&last)) = (active.first(), active.last()) else {
            continue;
        };
        let span = (start, last + SLOT_MINUTES);
        if due::is_rest_day(day) {
            rest.push(span);
        } else {
            work.push(span);
        }
    }
    let of = |spans: Vec<(u32, u32)>, min: usize| {
        if spans.len() < min {
            return DayHours::defaults();
        }
        let days = spans.len() as u32;
        DayHours {
            start: median(spans.iter().map(|s| s.0).collect()),
            end: median(spans.iter().map(|s| s.1).collect()),
            learned: true,
            days,
            set: false,
        }
    };
    Hours {
        workday: of(work, MIN_WORKDAYS),
        restday: of(rest, MIN_RESTDAYS),
    }
}

/// The owner's usual hours now: learned from the record, or the defaults
/// with the record off — and, over either, the hours they set themselves
/// (2.11), which no later learning overrides.
pub async fn hours(db: &DatabaseConnection, prefs: &Prefs, now: DateTime<Utc>) -> Hours {
    let learned = learned_hours(db, prefs, now).await;
    let set =
        crate::db::service::personal_agent_profile_service::get(db, super::profile::HOURS_KEY)
            .await
            .ok()
            .flatten()
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();
    super::profile::apply(learned, &set)
}

/// The usual hours as learned from the record alone; the defaults with the
/// record off.
pub async fn learned_hours(db: &DatabaseConnection, prefs: &Prefs, now: DateTime<Utc>) -> Hours {
    if !prefs.records_presence() {
        return Hours::default();
    }
    let tz = clock::zone_of(&prefs.time_zone);
    let today = hours_day(now, tz);
    // A day's small hours are on the next date.
    let rows = activity::since(db, today - Duration::days(LEARN_DAYS))
        .await
        .unwrap_or_default();
    learn(&rows, today)
}

/// A time of the hours, `HH:MM` — "01:30 after midnight" past 24:00.
pub fn clock_words(minutes: u32) -> String {
    if minutes >= 24 * 60 {
        let m = minutes - 24 * 60;
        format!("{:02}:{:02} after midnight", m / 60, m % 60)
    } else {
        format!("{:02}:{:02}", minutes / 60, minutes % 60)
    }
}

/// What `<codeg-now>` says of the owner: whether they are in codeg, and
/// their usual hours today once codeg has learned them.
pub fn about_owner(p: &Presence, hours: &Hours, tz: Tz, now: DateTime<Utc>) -> String {
    let mut out = if p.present {
        "the owner is in codeg now".to_string()
    } else if let Some(t) = p.last_active {
        format!(
            "the owner is away from codeg (last active {})",
            due::when_past(t, tz, now)
        )
    } else {
        "the owner has not been active in codeg since it started".to_string()
    };
    let today = hours_day(now, tz);
    let d = hours.on(today);
    if d.learned {
        out.push_str(&format!(
            " · their usual hours on a {}: {}–{}",
            if due::is_rest_day(today) {
                "rest day"
            } else {
                "workday"
            },
            clock_words(d.start),
            clock_words(d.end)
        ));
    }
    out
}

/// The "about you" page (13.5, 1.12, 2.11): the time zone as set and as it
/// is, every zone there is to pick, the record's switch, whether the owner
/// is in codeg, the hours codeg sees (with theirs over them), the projects
/// and agents it sees them use, and how they answer its cards.
#[derive(Debug, Clone, Serialize)]
pub struct ProfileView {
    /// As set: `system` or a zone's name.
    pub time_zone: String,
    /// The zone in effect.
    pub zone: String,
    pub system_zone: String,
    pub zones: Vec<&'static str>,
    /// The record is kept.
    pub presence: bool,
    pub present: bool,
    pub last_active: Option<DateTime<Utc>>,
    pub hours: Hours,
    /// What the record alone says (the defaults with it off): what the
    /// hours go back to when the owner lets go of theirs.
    pub learned_hours: Hours,
    pub learn_days: i64,
    /// The record of how the owner answers cards is kept (5.2).
    pub reactions: bool,
    /// What is seen counts from here: [`super::profile::OBSERVE_DAYS`] back,
    /// or when the owner cleared it.
    pub seen_since: DateTime<Utc>,
    pub cleared_at: Option<DateTime<Utc>>,
    pub projects: Vec<super::profile::ProjectSeen>,
    /// Projects the owner asked codeg not to mind that are not among the
    /// ones seen: by id and name, to take back.
    pub excluded: Vec<(i32, String)>,
    pub agents: Vec<super::profile::AgentShare>,
    /// Empty with the record of their answers off.
    pub cards: Vec<super::profile::CardReaction>,
}

pub async fn profile(app: &crate::db::AppDatabase) -> ProfileView {
    let db = &app.conn;
    let prefs = account_prefs(db).await.unwrap_or_default();
    let now = clock::now();
    let p = now_state();
    let observed = super::profile::observe(app, now).await;
    let seen: std::collections::HashSet<i32> =
        observed.projects.iter().map(|p| p.folder_id).collect();
    let folders = super::overview::Folders::load(app).await;
    let excluded = super::profile::excluded(app)
        .await
        .into_iter()
        .filter(|f| !seen.contains(f))
        .filter_map(|f| folders.project(f).filter(|(id, _)| *id == f))
        .collect();
    let reactions = prefs.records_reactions();
    ProfileView {
        zone: clock::zone_of(&prefs.time_zone).name().to_string(),
        system_zone: clock::system_tz().name().to_string(),
        zones: chrono_tz::TZ_VARIANTS.iter().map(|tz| tz.name()).collect(),
        presence: prefs.records_presence(),
        present: p.present,
        last_active: p.last_active,
        hours: hours(db, &prefs, now).await,
        learned_hours: learned_hours(db, &prefs, now).await,
        learn_days: LEARN_DAYS,
        reactions,
        seen_since: observed.since,
        cleared_at: super::profile::cleared_at(app).await,
        projects: observed.projects,
        excluded,
        agents: observed.agents,
        cards: if reactions {
            super::profile::reactions(app, now).await
        } else {
            Vec::new()
        },
        time_zone: prefs.time_zone,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn t0() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 11, 2, 0, 0).unwrap()
    }

    fn beat(t: &mut Tracker, window: &str, focused: bool, idle_ms: Option<u64>, at: DateTime<Utc>) {
        t.beat(
            &Beat {
                window: window.into(),
                focused,
                idle_ms,
                typed_ms: None,
                viewing: None,
                viewing_conversation: None,
            },
            at,
        );
    }

    #[test]
    fn present_is_a_focused_window_with_input_in_the_last_two_minutes() {
        let mut t = Tracker::default();
        let now = t0();
        assert!(!t.state(now).present);
        assert_eq!(t.state(now).last_active, None);
        // Focused, no input yet.
        beat(&mut t, "a", true, None, now);
        assert!(!t.state(now).present);
        beat(&mut t, "a", true, Some(5_000), now);
        assert!(t.state(now).present);
        assert_eq!(t.state(now).last_active, Some(now - Duration::seconds(5)));
        // It goes on beating with no more input: two minutes on, away.
        beat(&mut t, "a", true, Some(65_000), now + Duration::seconds(60));
        beat(
            &mut t,
            "a",
            true,
            Some(105_000),
            now + Duration::seconds(100),
        );
        assert!(t.state(now + Duration::seconds(110)).present);
        assert!(!t.state(now + Duration::seconds(116)).present);
        assert_eq!(t.state(now).last_active, Some(now - Duration::seconds(5)));
        // Away from the window: away at once, input or not.
        beat(&mut t, "a", false, Some(0), now + Duration::seconds(10));
        assert!(!t.state(now + Duration::seconds(10)).present);
        // Another window, focused and used, is presence.
        beat(&mut t, "b", true, Some(0), now + Duration::seconds(20));
        assert!(t.state(now + Duration::seconds(20)).present);
        // A window that stops beating is gone.
        assert!(
            !t.state(now + Duration::seconds(20 + WINDOW_GONE_SECS))
                .present
        );
    }

    #[test]
    fn an_older_input_never_takes_the_last_active_back() {
        let mut t = Tracker::default();
        let now = t0();
        beat(&mut t, "a", true, Some(0), now);
        beat(&mut t, "b", true, Some(600_000), now + Duration::seconds(1));
        assert_eq!(t.state(now).last_active, Some(now));
        beat(
            &mut t,
            "a",
            true,
            Some(u64::MAX),
            now + Duration::seconds(2),
        );
        assert_eq!(
            t.state(now).last_active,
            Some(now),
            "a silly idle is clamped, not trusted"
        );
    }

    #[test]
    fn each_present_minute_is_recorded_once() {
        let mut t = Tracker::default();
        let now = t0();
        assert!(!t.claim_minute(now), "not present: nothing to record");
        beat(&mut t, "a", true, Some(0), now);
        assert!(t.claim_minute(now));
        assert!(
            !t.claim_minute(now + Duration::seconds(30)),
            "the same minute"
        );
        assert!(t.claim_minute(now + Duration::seconds(61)));
        let day = NaiveDate::from_ymd_opt(2026, 11, 11).unwrap();
        assert!(t.claim_prune(day) && !t.claim_prune(day));
    }

    #[test]
    fn the_windows_kept_are_bounded() {
        let mut t = Tracker::default();
        let now = t0();
        for i in 0..(MAX_WINDOWS + 10) {
            beat(
                &mut t,
                &format!("w{i}"),
                false,
                None,
                now + Duration::milliseconds(i as i64),
            );
        }
        assert_eq!(t.windows.len(), MAX_WINDOWS);
        beat(&mut t, &"x".repeat(500), false, None, now);
        assert!(t.windows.keys().all(|k| k.chars().count() <= MAX_WINDOW_ID));
    }

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    /// A day active from `from` to `to` (minutes; `to` may pass 24:00),
    /// every slot full.
    fn day_of(rows: &mut Vec<(NaiveDate, u32, u32)>, date: NaiveDate, from: u32, to: u32) {
        let mut m = from;
        while m < to {
            let (dd, mm) = if m >= 24 * 60 {
                (date.succ_opt().unwrap(), m - 24 * 60)
            } else {
                (date, m)
            };
            rows.push((dd, mm / SLOT_MINUTES, 5));
            m += SLOT_MINUTES;
        }
    }

    #[test]
    fn hours_are_the_defaults_until_enough_days_are_seen() {
        let today = d("2026-11-11"); // a Wednesday
        assert_eq!(learn(&[], today), Hours::default());
        let mut rows = Vec::new();
        // Four workdays: not yet.
        for date in ["2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"] {
            day_of(&mut rows, d(date), 9 * 60 + 30, 18 * 60);
        }
        let h = learn(&rows, today);
        assert!(!h.workday.learned);
        assert_eq!(h.mornings(), Mornings::default());
        day_of(&mut rows, d("2026-11-09"), 9 * 60 + 40, 19 * 60);
        let h = learn(&rows, today);
        assert!(h.workday.learned);
        assert_eq!(
            (h.workday.start, h.workday.end, h.workday.days),
            (9 * 60 + 30, 18 * 60, 5)
        );
        assert_eq!(
            h.mornings().workday,
            NaiveTime::from_hms_opt(9, 30, 0).unwrap()
        );
        assert!(!h.restday.learned, "no weekend seen");
        assert_eq!(h.mornings().restday, Mornings::default().restday);
    }

    #[test]
    fn a_late_night_is_the_evenings_and_a_lone_minute_is_noise() {
        let today = d("2026-11-16"); // Monday
        let mut rows = Vec::new();
        for date in ["2026-11-07", "2026-11-08", "2026-11-14", "2026-11-15"] {
            // Weekends from 11:00 to 01:30 the next morning.
            day_of(&mut rows, d(date), 11 * 60, 25 * 60 + 30);
            // A single minute at 07:00: noise.
            rows.push((d(date), 7 * 60 / SLOT_MINUTES, 1));
        }
        let h = learn(&rows, today);
        assert!(h.restday.learned);
        assert_eq!((h.restday.start, h.restday.end), (11 * 60, 25 * 60 + 30));
        assert_eq!(clock_words(h.restday.end), "01:30 after midnight");
        assert_eq!(
            h.mornings().restday,
            NaiveTime::from_hms_opt(11, 0, 0).unwrap()
        );
        // Today is not counted, nor anything older than the window.
        let mut rows = Vec::new();
        for date in [
            "2026-10-01",
            "2026-10-02",
            "2026-10-05",
            "2026-10-06",
            "2026-10-07",
        ] {
            day_of(&mut rows, d(date), 8 * 60, 17 * 60);
        }
        assert!(!learn(&rows, today).workday.learned);
    }

    #[test]
    fn a_day_with_a_few_minutes_says_nothing() {
        let today = d("2026-11-16");
        let mut rows = Vec::new();
        for date in [
            "2026-11-09",
            "2026-11-10",
            "2026-11-11",
            "2026-11-12",
            "2026-11-13",
        ] {
            rows.push((d(date), 100, 5));
            rows.push((d(date), 101, 5));
        }
        assert!(!learn(&rows, today).workday.learned, "ten minutes a day");
    }

    #[test]
    fn the_owner_is_described_with_their_hours_once_learned() {
        let sh: Tz = "Asia/Shanghai".parse().unwrap();
        let now = Utc.with_ymd_and_hms(2026, 11, 11, 2, 0, 0).unwrap(); // Wed 10:00
        let here = Presence {
            present: true,
            last_active: Some(now),
        };
        assert_eq!(
            about_owner(&here, &Hours::default(), sh, now),
            "the owner is in codeg now"
        );
        let away = Presence {
            present: false,
            last_active: Some(now - Duration::minutes(30)),
        };
        assert_eq!(
            about_owner(&away, &Hours::default(), sh, now),
            "the owner is away from codeg (last active today 09:30)"
        );
        let never = Presence {
            present: false,
            last_active: None,
        };
        let h = Hours {
            workday: DayHours {
                start: 9 * 60 + 10,
                end: 18 * 60 + 40,
                learned: true,
                days: 12,
                set: false,
            },
            ..Hours::default()
        };
        assert_eq!(
            about_owner(&never, &h, sh, now),
            "the owner has not been active in codeg since it started · their usual hours on a \
             workday: 09:10–18:40"
        );
        // At 01:00 on Thursday it is still Wednesday's night.
        let late = Utc.with_ymd_and_hms(2026, 11, 11, 17, 0, 0).unwrap();
        assert_eq!(hours_day(late, sh), d("2026-11-11"));
    }
}
