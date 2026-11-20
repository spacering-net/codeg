//! When an open matter is due, how it repeats, and the words for times (6.1).
//!
//! All of it pure: the owner's zone and "now" come in as arguments, so the
//! rules — daylight saving, the end of a month, weekdays, what was missed
//! while codeg was not running — are tested by setting them.
//!
//! A repeating matter keeps the owner's wall-clock time (`at`, in their
//! zone): "every weekday at 09:00" stays at 09:00 across a change to or
//! from summer time. A local time that does not exist that day (the hour
//! skipped in spring) moves to the first one that does; one that happens
//! twice (the hour repeated in autumn) is the first.

use chrono::{
    DateTime, Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime, Offset, TimeZone, Utc,
    Weekday,
};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// How far ahead a matter may be due.
pub const MAX_AHEAD_DAYS: i64 = 366;
/// A due time this far in the past still counts as now (the minute the
/// assistant read in `<codeg-now>` may just have gone by).
pub const PAST_GRACE_SECS: i64 = 60;
/// A matter that fires this much after its time was missed — codeg was not
/// running, the machine slept — and its card says how late it is.
pub const LATE_AFTER_SECS: i64 = 120;
/// "Tomorrow morning", until the owner's day is learned (1.12).
pub const MORNING: (u32, u32) = (9, 0);
/// Before this hour, "tomorrow morning" is the morning about to come.
pub const SMALL_HOURS_END: u32 = 5;

/// When the owner's day usually starts, on a workday and on a rest day
/// (Saturday, Sunday) — what "tomorrow morning" means (1.12). [`MORNING`]
/// until codeg has learned it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Mornings {
    pub workday: NaiveTime,
    pub restday: NaiveTime,
}

impl Default for Mornings {
    fn default() -> Self {
        let at = NaiveTime::from_hms_opt(MORNING.0, MORNING.1, 0).unwrap_or(NaiveTime::MIN);
        Self {
            workday: at,
            restday: at,
        }
    }
}

impl Mornings {
    /// The morning of `date`.
    pub fn on(&self, date: NaiveDate) -> NaiveTime {
        if is_rest_day(date) {
            self.restday
        } else {
            self.workday
        }
    }
}

/// Saturday and Sunday.
pub fn is_rest_day(date: NaiveDate) -> bool {
    matches!(date.weekday(), Weekday::Sat | Weekday::Sun)
}

/// How a matter repeats.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Every {
    Daily,
    /// Monday to Friday.
    Weekdays,
    /// On the given days of the week.
    Weekly,
    /// On the given day of the month; past a short month's end, its last.
    Monthly,
}

/// A day of the week, as the rules write it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Day {
    Mon,
    Tue,
    Wed,
    Thu,
    Fri,
    Sat,
    Sun,
}

impl Day {
    fn weekday(self) -> Weekday {
        match self {
            Day::Mon => Weekday::Mon,
            Day::Tue => Weekday::Tue,
            Day::Wed => Weekday::Wed,
            Day::Thu => Weekday::Thu,
            Day::Fri => Weekday::Fri,
            Day::Sat => Weekday::Sat,
            Day::Sun => Weekday::Sun,
        }
    }

    fn of(w: Weekday) -> Self {
        match w {
            Weekday::Mon => Day::Mon,
            Weekday::Tue => Day::Tue,
            Weekday::Wed => Day::Wed,
            Weekday::Thu => Day::Thu,
            Weekday::Fri => Day::Fri,
            Weekday::Sat => Day::Sat,
            Weekday::Sun => Day::Sun,
        }
    }
}

/// A matter's repeat rule (`personal_agent_item.repeat`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Repeat {
    pub every: Every,
    /// `weekly`: the days.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub days: Vec<Day>,
    /// `monthly`: the day of the month, 1–31.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub day: Option<u32>,
    /// The owner's wall-clock time, `HH:MM`.
    pub at: String,
    /// The last day it may fall on, in the owner's zone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<NaiveDate>,
    /// The zone its next time was set in (1.12): when the owner's zone is
    /// another, the clock moves that time to `at` in theirs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zone: Option<String>,
    /// Its next time is a moment of its own — the owner put it off, or the
    /// assistant moved it — not the rule's: a change of zone leaves it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub moment: bool,
}

impl Repeat {
    pub fn parse(raw: Option<&str>) -> Option<Self> {
        serde_json::from_str(raw?).ok()
    }

    /// Its next time set in `tz`: the rule's own (`moment` false), or a
    /// moment of its own.
    pub fn placed(self, tz: Tz, moment: bool) -> Self {
        Self {
            zone: Some(tz.name().to_string()),
            moment,
            ..self
        }
    }

    /// Its wall-clock time.
    pub fn time(&self) -> NaiveTime {
        NaiveTime::parse_from_str(&self.at, "%H:%M").unwrap_or(NaiveTime::MIN)
    }

    fn falls_on(&self, date: NaiveDate) -> bool {
        match self.every {
            Every::Daily => true,
            Every::Weekdays => !matches!(date.weekday(), Weekday::Sat | Weekday::Sun),
            Every::Weekly => self.days.iter().any(|d| d.weekday() == date.weekday()),
            Every::Monthly => {
                let want = self.day.unwrap_or(1).clamp(1, 31);
                date.day() == want.min(days_in_month(date))
            }
        }
    }
}

fn days_in_month(date: NaiveDate) -> u32 {
    let (y, m) = (date.year(), date.month());
    let first_next = if m == 12 {
        NaiveDate::from_ymd_opt(y + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(y, m + 1, 1)
    };
    first_next
        .and_then(|d| d.pred_opt())
        .map(|d| d.day())
        .unwrap_or(28)
}

/// What happens when a matter is due.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AtDue {
    /// A reminder card for the owner; the assistant is not woken.
    Notify,
    /// The assistant is woken to do it.
    Act,
}

impl AtDue {
    pub fn parse(raw: Option<&str>) -> Option<Self> {
        match raw? {
            "notify" => Some(AtDue::Notify),
            "act" => Some(AtDue::Act),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            AtDue::Notify => "notify",
            AtDue::Act => "act",
        }
    }
}

/// What an `act` matter is to do when it comes due: a note, and a draft of
/// the dispatch it may make — handed back to the assistant then, as it was
/// written.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActSpec {
    pub what: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dispatch: Option<serde_json::Map<String, Value>>,
}

impl ActSpec {
    pub fn parse(raw: Option<&str>) -> Option<Self> {
        serde_json::from_str(raw?).ok()
    }
}

/// The longest note an `act` matter keeps.
pub const MAX_ACT_WHAT: usize = 2_000;
/// The longest dispatch draft it keeps (its JSON).
pub const MAX_ACT_DISPATCH: usize = 6_000;
/// The fields a dispatch draft may have — the `dispatch` tool's.
const DISPATCH_FIELDS: &[&str] = &[
    "mode",
    "title",
    "prompt",
    "project_id",
    "deliverable",
    "on_done",
];

/// An `act_spec` as the assistant wrote it: a note (a bare string is one),
/// with or without a dispatch draft.
pub fn parse_act_spec(v: &Value) -> Result<ActSpec, String> {
    let (what, dispatch) = match v {
        Value::String(s) => (s.clone(), None),
        Value::Object(map) => {
            let what = map
                .get("what")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let dispatch = match map.get("dispatch") {
                None | Some(Value::Null) => None,
                Some(Value::Object(d)) => {
                    if let Some(bad) = d.keys().find(|k| !DISPATCH_FIELDS.contains(&k.as_str())) {
                        return Err(format!(
                            "`act_spec.dispatch` takes the dispatch tool's fields ({}); `{bad}` is not one",
                            DISPATCH_FIELDS.join(", ")
                        ));
                    }
                    if Value::Object(d.clone()).to_string().chars().count() > MAX_ACT_DISPATCH {
                        return Err(format!(
                            "`act_spec.dispatch` is longer than {MAX_ACT_DISPATCH} characters"
                        ));
                    }
                    Some(d.clone())
                }
                Some(_) => return Err("`act_spec.dispatch` must be an object".into()),
            };
            (what, dispatch)
        }
        _ => return Err("`act_spec` must be an object { what, dispatch? }".into()),
    };
    let what = what.trim().chars().take(MAX_ACT_WHAT).collect::<String>();
    if what.is_empty() && dispatch.is_none() {
        return Err("`act_spec` needs `what`: what you are to do then".into());
    }
    Ok(ActSpec { what, dispatch })
}

/// A repeat rule as the assistant wrote it (`{ every, days?, day?, until? }`,
/// or just the `every` word), for a matter whose first time is `first` —
/// whose wall-clock time it keeps, and whose weekday or day of the month a
/// rule that names none takes.
pub fn parse_repeat(v: &Value, first: NaiveDateTime) -> Result<Repeat, String> {
    let (every, map) = match v {
        Value::String(s) => (s.as_str(), None),
        Value::Object(m) => (
            m.get("every").and_then(Value::as_str).unwrap_or_default(),
            Some(m),
        ),
        _ => return Err("`repeat` must be an object { every, days?, day?, until? }".into()),
    };
    let every = match every {
        "daily" => Every::Daily,
        "weekdays" => Every::Weekdays,
        "weekly" => Every::Weekly,
        "monthly" => Every::Monthly,
        _ => return Err("`repeat.every` must be daily, weekdays, weekly or monthly".into()),
    };
    let field = |name: &str| map.and_then(|m| m.get(name)).filter(|v| !v.is_null());
    let mut days = Vec::new();
    if let Some(list) = field("days") {
        let Some(list) = list.as_array() else {
            return Err("`repeat.days` must be a list such as [\"mon\", \"thu\"]".into());
        };
        for d in list {
            let day: Day = serde_json::from_value(d.clone())
                .map_err(|_| "`repeat.days` takes mon, tue, wed, thu, fri, sat, sun".to_string())?;
            if !days.contains(&day) {
                days.push(day);
            }
        }
    }
    let day = match field("day") {
        Some(v) => match v.as_u64() {
            Some(n @ 1..=31) => Some(n as u32),
            _ => return Err("`repeat.day` must be a day of the month, 1–31".into()),
        },
        None => None,
    };
    let until = match field("until") {
        Some(v) => {
            let s = v.as_str().unwrap_or_default();
            let date = NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d")
                .map_err(|_| "`repeat.until` must be a date, YYYY-MM-DD".to_string())?;
            if date < first.date() {
                return Err("`repeat.until` is before its first time".into());
            }
            Some(date)
        }
        None => None,
    };
    let (days, day) = match every {
        Every::Weekly if days.is_empty() => (vec![Day::of(first.weekday())], None),
        Every::Weekly => (days, None),
        Every::Monthly => (Vec::new(), Some(day.unwrap_or(first.day()))),
        _ => (Vec::new(), None),
    };
    Ok(Repeat {
        every,
        days,
        day,
        at: first.time().format("%H:%M").to_string(),
        until,
        zone: None,
        moment: false,
    })
}

/// The instant of a wall-clock time in `tz`: a time skipped by a change to
/// summer time moves to the first that exists; one that happens twice is
/// the first.
pub fn local_at(tz: Tz, local: NaiveDateTime) -> DateTime<Utc> {
    let mut t = local;
    for _ in 0..=180 {
        match tz.from_local_datetime(&t) {
            chrono::LocalResult::Single(x) => return x.with_timezone(&Utc),
            chrono::LocalResult::Ambiguous(a, _) => return a.with_timezone(&Utc),
            chrono::LocalResult::None => t += Duration::minutes(1),
        }
    }
    // No zone skips three hours; read it as UTC rather than fail.
    Utc.from_utc_datetime(&local)
}

/// The rule's first time after `t`, or `None` once it has ended.
pub fn next_after(rule: &Repeat, tz: Tz, t: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let at = rule.time();
    let mut date = t.with_timezone(&tz).date_naive().pred_opt()?;
    for _ in 0..400 {
        if rule.until.is_some_and(|u| date > u) {
            return None;
        }
        if rule.falls_on(date) {
            let occ = local_at(tz, date.and_time(at));
            if occ > t {
                return Some(occ);
            }
        }
        date = date.succ_opt()?;
    }
    None
}

/// The occurrence that fires when a matter due at `from` is looked at
/// `now`: for a repeating one, the latest of its times by then — those
/// before it were missed and are not sent again — and how many those were.
pub fn catch_up(
    rule: Option<&Repeat>,
    tz: Tz,
    from: DateTime<Utc>,
    now: DateTime<Utc>,
) -> (DateTime<Utc>, u32) {
    let mut occ = from;
    let mut missed = 0;
    if let Some(rule) = rule {
        for _ in 0..5_000 {
            match next_after(rule, tz, occ) {
                Some(n) if n <= now => {
                    occ = n;
                    missed += 1;
                }
                _ => break,
            }
        }
    }
    (occ, missed)
}

/// "Tomorrow morning": when the owner's next day starts (`mornings`) — the
/// day about to come, in the small hours; never a time already gone.
pub fn morning(tz: Tz, now: DateTime<Utc>, mornings: Mornings) -> DateTime<Utc> {
    let local = now.with_timezone(&tz);
    let small_hours =
        local.time() < NaiveTime::from_hms_opt(SMALL_HOURS_END, 0, 0).unwrap_or(NaiveTime::MIN);
    let mut date = if small_hours {
        local.date_naive()
    } else {
        local.date_naive().succ_opt().unwrap_or(local.date_naive())
    };
    let mut t = local_at(tz, date.and_time(mornings.on(date)));
    if t <= now {
        date = date.succ_opt().unwrap_or(date);
        t = local_at(tz, date.and_time(mornings.on(date)));
    }
    t
}

/// A time as the assistant or the page wrote it: ISO 8601 with an offset;
/// `YYYY-MM-DD HH:MM`, in the owner's zone; or from now — `15m`, `1h`,
/// `2d`, `tomorrow` (morning, as `mornings` has it).
pub fn parse_when(
    text: &str,
    tz: Tz,
    now: DateTime<Utc>,
    mornings: Mornings,
) -> Result<DateTime<Utc>, String> {
    let s = text.trim();
    if s.eq_ignore_ascii_case("tomorrow") {
        return Ok(morning(tz, now, mornings));
    }
    if let Some(d) = relative(s) {
        return Ok(now + d);
    }
    if let Ok(t) = DateTime::parse_from_rfc3339(s) {
        return Ok(t.with_timezone(&Utc));
    }
    // An offset, no seconds; `Z` for UTC.
    let zoned = match s.strip_suffix('Z').or_else(|| s.strip_suffix('z')) {
        Some(rest) => format!("{rest}+00:00"),
        None => s.to_string(),
    };
    for f in [
        "%Y-%m-%dT%H:%M%:z",
        "%Y-%m-%d %H:%M%:z",
        "%Y-%m-%dT%H:%M%z",
        "%Y-%m-%d %H:%M%z",
    ] {
        if let Ok(t) = DateTime::parse_from_str(&zoned, f) {
            return Ok(t.with_timezone(&Utc));
        }
    }
    for f in [
        "%Y-%m-%d %H:%M",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
    ] {
        if let Ok(t) = NaiveDateTime::parse_from_str(s, f) {
            return Ok(local_at(tz, t));
        }
    }
    Err(format!(
        "`{s}` is not a time codeg reads: write `YYYY-MM-DD HH:MM` in the owner's time, ISO 8601 \
         with an offset, or `15m` / `1h` / `2d` / `tomorrow`"
    ))
}

fn relative(s: &str) -> Option<Duration> {
    let unit = s.chars().last()?;
    let n: i64 = s[..s.len() - unit.len_utf8()]
        .trim()
        .parse()
        .ok()
        .filter(|n| (1..=1_000_000).contains(n))?;
    match unit {
        'm' => Some(Duration::minutes(n)),
        'h' => Some(Duration::hours(n)),
        'd' => Some(Duration::days(n)),
        _ => None,
    }
}

/// A due time codeg keeps: not before now, not more than a year ahead.
pub fn check_due(t: DateTime<Utc>, tz: Tz, now: DateTime<Utc>) -> Result<(), String> {
    if t < now - Duration::seconds(PAST_GRACE_SECS) {
        return Err(format!(
            "{} is in the past — it is {} now",
            describe(t, tz, now),
            describe(now, tz, now)
        ));
    }
    if t > now + Duration::days(MAX_AHEAD_DAYS) {
        return Err(format!(
            "{} is more than a year ahead",
            describe(t, tz, now)
        ));
    }
    Ok(())
}

/// The zone as the assistant reads it: `Asia/Shanghai, UTC+08:00`.
pub fn zone_label(tz: Tz, at: DateTime<Utc>) -> String {
    let offset = tz.offset_from_utc_datetime(&at.naive_utc()).fix();
    format!("{}, UTC{offset}", tz.name())
}

/// A time in the owner's zone with its weekday, and the day it falls on
/// when that is near: `2026-11-12 15:00 Thu (tomorrow)`.
pub fn describe(t: DateTime<Utc>, tz: Tz, now: DateTime<Utc>) -> String {
    let local = t.with_timezone(&tz);
    let days = (local.date_naive() - now.with_timezone(&tz).date_naive()).num_days();
    let near = match days {
        0 => " (today)",
        1 => " (tomorrow)",
        -1 => " (yesterday)",
        _ => "",
    };
    format!("{}{near}", local.format("%Y-%m-%d %H:%M %a"))
}

/// A repeat rule in words: `every weekday (Mon–Fri) at 09:00`.
pub fn describe_repeat(rule: &Repeat) -> String {
    let base = match rule.every {
        Every::Daily => format!("every day at {}", rule.at),
        Every::Weekdays => format!("every weekday (Mon–Fri) at {}", rule.at),
        Every::Weekly => {
            let days = rule
                .days
                .iter()
                .map(|d| d.weekday().to_string())
                .collect::<Vec<_>>()
                .join(", ");
            format!("every {days} at {}", rule.at)
        }
        Every::Monthly => format!(
            "on day {} of every month at {} (the month's last day when it is shorter)",
            rule.day.unwrap_or(1),
            rule.at
        ),
    };
    match rule.until {
        Some(u) => format!("{base}, until {u}"),
        None => base,
    }
}

/// A span in words: `2 h 5 min`, `3 days`.
pub fn span(d: Duration) -> String {
    let mins = d.num_minutes().max(0);
    if mins < 60 {
        return format!("{mins} min");
    }
    let hours = mins / 60;
    if hours < 48 {
        return match mins % 60 {
            0 => format!("{hours} h"),
            m => format!("{hours} h {m} min"),
        };
    }
    format!("{} days", hours / 24)
}

/// When something happened, as the `<codeg-now>` line puts it: `today
/// 08:30`, `yesterday 18:41`, `Wed 11-05 10:00` within the week, else the
/// date.
pub fn when_past(t: DateTime<Utc>, tz: Tz, now: DateTime<Utc>) -> String {
    let local = t.with_timezone(&tz);
    let days = (now.with_timezone(&tz).date_naive() - local.date_naive()).num_days();
    match days {
        0 => format!("today {}", local.format("%H:%M")),
        1 => format!("yesterday {}", local.format("%H:%M")),
        2..=6 => local.format("%a %m-%d %H:%M").to_string(),
        _ => local.format("%Y-%m-%d %H:%M").to_string(),
    }
}

/// The line every delivery starts with (6.1): now in the owner's zone,
/// `about` the owner (whether they are in codeg, their usual hours — 1.12),
/// their last message before this turn, and what started it.
pub fn now_line(
    now: DateTime<Utc>,
    tz: Tz,
    about: &str,
    last_owner: Option<DateTime<Utc>>,
    started_by: &str,
) -> String {
    let local = now.with_timezone(&tz);
    let last = match last_owner {
        Some(t) => when_past(t, tz, now),
        None => "none yet".to_string(),
    };
    let about = if about.is_empty() {
        String::new()
    } else {
        format!(" · {about}")
    };
    format!(
        "<codeg-now>{} ({}){about} · the owner's last message before this turn: {last} · this \
         turn: {started_by}</codeg-now>",
        local.format("%Y-%m-%d %a %H:%M"),
        zone_label(tz, now),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tz(name: &str) -> Tz {
        name.parse().unwrap()
    }

    fn at(tz: Tz, s: &str) -> DateTime<Utc> {
        local_at(
            tz,
            NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M").unwrap(),
        )
    }

    fn local(t: DateTime<Utc>, tz: Tz) -> String {
        t.with_timezone(&tz).format("%Y-%m-%d %H:%M %a").to_string()
    }

    fn rule(v: Value, first: &str) -> Repeat {
        parse_repeat(
            &v,
            NaiveDateTime::parse_from_str(first, "%Y-%m-%d %H:%M").unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn a_time_is_read_in_the_owners_zone_or_with_its_offset() {
        let sh = tz("Asia/Shanghai");
        let now = at(sh, "2026-11-11 09:12");
        assert_eq!(
            parse_when("2026-11-12 15:00", sh, now, Mornings::default()).unwrap(),
            Utc.with_ymd_and_hms(2026, 11, 12, 7, 0, 0).unwrap()
        );
        for s in [
            "2026-11-12T15:00:00+08:00",
            "2026-11-12T15:00+08:00",
            "2026-11-12 07:00Z",
            "2026-11-12T07:00:00Z",
        ] {
            assert_eq!(
                parse_when(s, sh, now, Mornings::default()).unwrap(),
                Utc.with_ymd_and_hms(2026, 11, 12, 7, 0, 0).unwrap(),
                "{s}"
            );
        }
        assert_eq!(
            parse_when("15m", sh, now, Mornings::default()).unwrap(),
            now + Duration::minutes(15)
        );
        assert_eq!(
            parse_when("1h", sh, now, Mornings::default()).unwrap(),
            now + Duration::hours(1)
        );
        assert_eq!(
            parse_when("2d", sh, now, Mornings::default()).unwrap(),
            now + Duration::days(2)
        );
        assert!(parse_when("next friday", sh, now, Mornings::default()).is_err());
        for odd in ["明天", "3天", "", "m", "-5m", "99999999999999m"] {
            assert!(
                parse_when(odd, sh, now, Mornings::default()).is_err(),
                "{odd}"
            );
        }
        assert!(parse_when("0m", sh, now, Mornings::default()).is_err());
    }

    #[test]
    fn a_due_time_is_neither_past_nor_more_than_a_year_ahead() {
        let sh = tz("Asia/Shanghai");
        let now = at(sh, "2026-11-11 09:12");
        assert!(check_due(now + Duration::minutes(1), sh, now).is_ok());
        assert!(
            check_due(now - Duration::seconds(30), sh, now).is_ok(),
            "the minute just gone"
        );
        let past = check_due(now - Duration::hours(2), sh, now).unwrap_err();
        assert!(
            past.contains("in the past") && past.contains("2026-11-11 09:12 Wed"),
            "{past}"
        );
        assert!(check_due(now + Duration::days(366), sh, now).is_ok());
        assert!(check_due(now + Duration::days(367), sh, now).is_err());
    }

    #[test]
    fn the_skipped_hour_moves_on_and_the_repeated_one_is_the_first() {
        let ny = tz("America/New_York");
        // 2026-03-08 02:30 does not exist in New York: the first time that
        // does is 03:00 EDT.
        let spring = at(ny, "2026-03-08 02:30");
        assert_eq!(local(spring, ny), "2026-03-08 03:00 Sun");
        // 2026-11-01 01:30 happens twice: the first is EDT (UTC-4).
        let autumn = at(ny, "2026-11-01 01:30");
        assert_eq!(autumn, Utc.with_ymd_and_hms(2026, 11, 1, 5, 30, 0).unwrap());
    }

    #[test]
    fn a_daily_matter_keeps_its_wall_clock_time_across_summer_time() {
        let ny = tz("America/New_York");
        let r = rule(json!({"every": "daily"}), "2026-03-07 09:00");
        let first = at(ny, "2026-03-07 09:00");
        let next = next_after(&r, ny, first).unwrap();
        assert_eq!(local(next, ny), "2026-03-08 09:00 Sun");
        // 23 hours apart across the change, 9:00 on the clock both days.
        assert_eq!((next - first).num_hours(), 23);
    }

    #[test]
    fn weekdays_skip_the_weekend_and_weekly_takes_its_days() {
        let sh = tz("Asia/Shanghai");
        let r = rule(json!({"every": "weekdays"}), "2026-11-13 09:00");
        let fri = at(sh, "2026-11-13 09:00");
        assert_eq!(
            local(next_after(&r, sh, fri).unwrap(), sh),
            "2026-11-16 09:00 Mon"
        );
        let w = rule(
            json!({"every": "weekly", "days": ["mon", "thu"]}),
            "2026-11-12 18:30",
        );
        let thu = at(sh, "2026-11-12 18:30");
        assert_eq!(
            local(next_after(&w, sh, thu).unwrap(), sh),
            "2026-11-16 18:30 Mon"
        );
        // Weekly naming no day: the first time's.
        let w = rule(json!("weekly"), "2026-11-12 18:30");
        assert_eq!(w.days, vec![Day::Thu]);
        assert!(parse_repeat(
            &json!({"every": "weekly", "days": ["someday"]}),
            NaiveDateTime::parse_from_str("2026-11-12 18:30", "%Y-%m-%d %H:%M").unwrap()
        )
        .is_err());
    }

    #[test]
    fn a_monthly_matter_falls_on_a_short_months_last_day() {
        let sh = tz("Asia/Shanghai");
        let r = rule(json!({"every": "monthly", "day": 31}), "2027-01-31 10:00");
        let jan = at(sh, "2027-01-31 10:00");
        let feb = next_after(&r, sh, jan).unwrap();
        assert_eq!(local(feb, sh), "2027-02-28 10:00 Sun");
        let mar = next_after(&r, sh, feb).unwrap();
        assert_eq!(local(mar, sh), "2027-03-31 10:00 Wed");
        let apr = next_after(&r, sh, mar).unwrap();
        assert_eq!(local(apr, sh), "2027-04-30 10:00 Fri");
        // Naming no day: the first time's.
        assert_eq!(rule(json!("monthly"), "2027-01-15 10:00").day, Some(15));
    }

    #[test]
    fn a_repeat_ends_on_its_last_day() {
        let sh = tz("Asia/Shanghai");
        let r = rule(
            json!({"every": "daily", "until": "2026-11-13"}),
            "2026-11-12 09:00",
        );
        let thu = at(sh, "2026-11-12 09:00");
        let fri = next_after(&r, sh, thu).unwrap();
        assert_eq!(local(fri, sh), "2026-11-13 09:00 Fri");
        assert_eq!(next_after(&r, sh, fri), None);
        assert!(parse_repeat(
            &json!({"every": "daily", "until": "2026-11-01"}),
            NaiveDateTime::parse_from_str("2026-11-12 09:00", "%Y-%m-%d %H:%M").unwrap()
        )
        .is_err());
    }

    #[test]
    fn what_was_missed_fires_once_at_its_latest_time() {
        let sh = tz("Asia/Shanghai");
        let r = rule(json!({"every": "daily"}), "2026-11-09 09:00");
        let mon = at(sh, "2026-11-09 09:00");
        // Asleep from Monday morning to Thursday 10:00: Thursday's fires,
        // Monday's to Wednesday's were missed.
        let (occ, missed) = catch_up(Some(&r), sh, mon, at(sh, "2026-11-12 10:00"));
        assert_eq!(local(occ, sh), "2026-11-12 09:00 Thu");
        assert_eq!(missed, 3);
        // Not repeating: the one time, however late.
        let (occ, missed) = catch_up(None, sh, mon, at(sh, "2026-11-12 10:00"));
        assert_eq!((occ, missed), (mon, 0));
        // A snooze off the rule's times: the rule's next one after it.
        let snoozed = at(sh, "2026-11-09 09:15");
        let (occ, missed) = catch_up(Some(&r), sh, snoozed, at(sh, "2026-11-09 09:16"));
        assert_eq!((occ, missed), (snoozed, 0));
        assert_eq!(
            local(next_after(&r, sh, snoozed).unwrap(), sh),
            "2026-11-10 09:00 Tue"
        );
    }

    #[test]
    fn tomorrow_morning_is_this_morning_in_the_small_hours() {
        let sh = tz("Asia/Shanghai");
        let m = Mornings::default();
        assert_eq!(
            local(morning(sh, at(sh, "2026-11-11 15:00"), m), sh),
            "2026-11-12 09:00 Thu"
        );
        assert_eq!(
            local(morning(sh, at(sh, "2026-11-11 23:59"), m), sh),
            "2026-11-12 09:00 Thu"
        );
        assert_eq!(
            local(morning(sh, at(sh, "2026-11-12 01:30"), m), sh),
            "2026-11-12 09:00 Thu"
        );
        assert_eq!(
            parse_when("tomorrow", sh, at(sh, "2026-11-11 15:00"), m).unwrap(),
            at(sh, "2026-11-12 09:00")
        );
    }

    #[test]
    fn tomorrow_morning_is_when_the_owners_day_starts() {
        let sh = tz("Asia/Shanghai");
        let hm = |h, m| NaiveTime::from_hms_opt(h, m, 0).unwrap();
        let m = Mornings {
            workday: hm(9, 40),
            restday: hm(11, 0),
        };
        // Wed 15:00 → Thu, a workday.
        assert_eq!(
            local(morning(sh, at(sh, "2026-11-11 15:00"), m), sh),
            "2026-11-12 09:40 Thu"
        );
        // Fri → Sat, a rest day.
        assert_eq!(
            local(morning(sh, at(sh, "2026-11-13 20:00"), m), sh),
            "2026-11-14 11:00 Sat"
        );
        // An early riser's morning already gone in the small hours: the next.
        let early = Mornings {
            workday: hm(4, 30),
            restday: hm(4, 30),
        };
        assert_eq!(
            local(morning(sh, at(sh, "2026-11-12 04:40"), early), sh),
            "2026-11-13 04:30 Fri"
        );
        assert!(is_rest_day(NaiveDate::from_ymd_opt(2026, 11, 15).unwrap()));
        assert!(!is_rest_day(NaiveDate::from_ymd_opt(2026, 11, 16).unwrap()));
    }

    #[test]
    fn times_read_with_their_weekday_and_the_day_they_fall_on() {
        let sh = tz("Asia/Shanghai");
        let now = at(sh, "2026-11-11 09:12");
        assert_eq!(
            describe(at(sh, "2026-11-12 15:00"), sh, now),
            "2026-11-12 15:00 Thu (tomorrow)"
        );
        assert_eq!(
            describe(at(sh, "2026-11-11 18:00"), sh, now),
            "2026-11-11 18:00 Wed (today)"
        );
        assert_eq!(
            describe(at(sh, "2026-11-20 08:00"), sh, now),
            "2026-11-20 08:00 Fri"
        );
        assert_eq!(zone_label(sh, now), "Asia/Shanghai, UTC+08:00");
        assert_eq!(
            when_past(at(sh, "2026-11-10 18:41"), sh, now),
            "yesterday 18:41"
        );
        assert_eq!(
            when_past(at(sh, "2026-11-11 08:30"), sh, now),
            "today 08:30"
        );
        assert_eq!(
            when_past(at(sh, "2026-11-07 10:00"), sh, now),
            "Sat 11-07 10:00"
        );
        assert_eq!(
            when_past(at(sh, "2026-10-01 10:00"), sh, now),
            "2026-10-01 10:00"
        );
        assert_eq!(span(Duration::minutes(125)), "2 h 5 min");
        assert_eq!(span(Duration::hours(2)), "2 h");
        assert_eq!(span(Duration::hours(80)), "3 days");
        let line = now_line(
            now,
            sh,
            "",
            Some(at(sh, "2026-11-10 18:41")),
            "the owner's message",
        );
        assert_eq!(
            line,
            "<codeg-now>2026-11-11 Wed 09:12 (Asia/Shanghai, UTC+08:00) · the owner's last message \
             before this turn: yesterday 18:41 · this turn: the owner's message</codeg-now>"
        );
        let line = now_line(
            now,
            sh,
            "the owner is in codeg now",
            None,
            "the owner's message",
        );
        assert!(
            line.contains("UTC+08:00) · the owner is in codeg now · the owner's last message"),
            "{line}"
        );
        assert_eq!(
            describe_repeat(&rule(
                json!({"every": "weekly", "days": ["mon", "wed"], "until": "2026-12-31"}),
                "2026-11-11 09:00"
            )),
            "every Mon, Wed at 09:00, until 2026-12-31"
        );
    }

    #[test]
    fn an_act_spec_is_a_note_with_or_without_a_dispatch_draft() {
        assert_eq!(
            parse_act_spec(&json!("check the CI")).unwrap().what,
            "check the CI"
        );
        let spec = parse_act_spec(&json!({"what": "release", "dispatch": {"mode": "task", "title": "Release", "prompt": "Tag v1"}})).unwrap();
        assert_eq!(spec.dispatch.unwrap()["mode"], "task");
        assert!(parse_act_spec(&json!({"what": "x", "dispatch": {"command": "rm"}})).is_err());
        // No executor config in a draft: the dispatch it becomes takes none.
        assert!(parse_act_spec(&json!({"what": "x", "dispatch": {"mode": "chat", "assistant_id": 3}}))
            .unwrap_err()
            .contains("`assistant_id` is not one"));
        assert!(parse_act_spec(&json!({"what": "  "})).is_err());
        assert!(parse_act_spec(&json!(3)).is_err());
    }
}
