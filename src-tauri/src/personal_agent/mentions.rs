//! Reminders that come up when the owner mentions something (6.8): "next
//! time I mention a release, remind me to update the Homebrew formula
//! first."
//!
//! - **What**: a `when_mentioned` matter — keywords, and the reminder as its
//!   summary — made with `item_update`.
//! - **When**: each message the owner types is matched, before it is
//!   delivered and without a model, against every open one of every
//!   assistant: a keyword in CJK script anywhere in it, any other at the
//!   start of a word, a short one (three letters or fewer) as a whole word
//!   (`matches`). A card's button, a hand-over written by a
//!   card and a message sent again do not count; one sent again carries
//!   what its first copy brought up.
//! - **Then**: what it brought up is written on the message's row, once —
//!   the delivery that carries the message (in a turn's batch, or folded
//!   into the turn in flight) carries the reminders with it, and the page
//!   shows them under the message.
//! - **How often**: once in [`COOLDOWN_HOURS`] hours, [`MAX_TIMES`] times,
//!   for [`EXPIRES_DAYS`] days, unless the assistant set otherwise. Used up
//!   it is done; past its time, dropped. Only the owner cancels one.

use std::collections::HashMap;

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::clock;
use super::engine::{change_payload, PersonalAgentEngine, PERSONAL_AGENT_CHANGED_EVENT};
use super::host::EngineHost;
use crate::db::entities::personal_agent_item::{self as item_entity, ItemStatus};
use crate::db::service::personal_agent_service as svc;
use crate::models::personal_agent::PersonalAgentChange;
use crate::web::event_bridge::{emit_event, EventEmitter};

/// Hours between two times one comes up.
pub const COOLDOWN_HOURS: u32 = 24;
/// Times one comes up before it is done.
pub const MAX_TIMES: u32 = 3;
/// Days one lasts.
pub const EXPIRES_DAYS: u32 = 90;
const MAX_KEYWORDS: usize = 10;
const MIN_KEYWORD_CHARS: usize = 2;
const MAX_KEYWORD_CHARS: usize = 40;
const MAX_COOLDOWN_HOURS: u64 = 24 * 30;
const MAX_MAX_TIMES: u64 = 20;
const MAX_EXPIRES_DAYS: u64 = 365;

/// Where an owner message's row keeps what it brought up.
pub const ROW_KEY: &str = "mentioned";

/// A `when_mentioned` matter's keywords and how it comes up, as stored.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Mention {
    pub keywords: Vec<String>,
    pub cooldown_hours: u32,
    pub max_times: u32,
    pub expires_at: DateTime<Utc>,
    /// How many times it came up.
    #[serde(default)]
    pub times: u32,
    /// When it last did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_at: Option<DateTime<Utc>>,
}

impl Mention {
    pub fn parse(raw: Option<&str>) -> Option<Self> {
        serde_json::from_str(raw?).ok()
    }

    pub fn of(item: &item_entity::Model) -> Option<Self> {
        Self::parse(item.mention.as_deref())
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    /// The keyword `text` mentions: the longest of those it does.
    pub fn hit(&self, text: &str) -> Option<&str> {
        let hay = text.to_lowercase();
        self.keywords
            .iter()
            .filter(|k| matches(&hay, &k.trim().to_lowercase()))
            .max_by_key(|k| k.chars().count())
            .map(String::as_str)
    }

    pub fn expired(&self, now: DateTime<Utc>) -> bool {
        now >= self.expires_at
    }

    pub fn used_up(&self) -> bool {
        self.times >= self.max_times
    }

    /// Whether it may come up now: times left, its days not over, the last
    /// time a cooldown ago.
    pub fn ready(&self, now: DateTime<Utc>) -> bool {
        !self.used_up()
            && !self.expired(now)
            && self
                .last_at
                .is_none_or(|l| now - l >= Duration::hours(i64::from(self.cooldown_hours)))
    }

    /// How it stands, for the assistant: its words, and its times.
    pub fn describe(&self, now: DateTime<Utc>) -> String {
        let words = self
            .keywords
            .iter()
            .map(|k| format!("\"{k}\""))
            .collect::<Vec<_>>()
            .join(", ");
        let days = (self.expires_at - now).num_days().max(0);
        format!(
            "when the owner mentions {words} · came up {} of {} times · at most once in {} h · {days} more days",
            self.times, self.max_times, self.cooldown_hours
        )
    }
}

/// The `when_mentioned` of a tool call — the keywords alone (a list or one
/// word), or `{ keywords, cooldown_hours, max_times, expires_in_days }` —
/// onto `earlier` when it changes a matter's: what it leaves out stays, and
/// the times it came up are kept.
pub fn from_args(
    v: &Value,
    earlier: Option<&Mention>,
    now: DateTime<Utc>,
) -> Result<Mention, String> {
    let shape = "`when_mentioned` takes the keywords (a list), or { keywords, cooldown_hours, \
                 max_times, expires_in_days }";
    let (words, obj) = match v {
        Value::Array(a) => (Some(a.clone()), None),
        Value::String(s) => (Some(vec![Value::String(s.clone())]), None),
        Value::Object(o) => (
            match o.get("keywords") {
                None | Some(Value::Null) => None,
                Some(Value::Array(a)) => Some(a.clone()),
                Some(Value::String(s)) => Some(vec![Value::String(s.clone())]),
                Some(_) => return Err(shape.into()),
            },
            Some(o),
        ),
        _ => return Err(shape.into()),
    };
    let keywords = match words {
        Some(list) => {
            let mut out: Vec<String> = Vec::new();
            for w in list {
                let Some(w) = w.as_str().map(str::trim).filter(|w| !w.is_empty()) else {
                    return Err("each keyword is a word or a phrase, as text".into());
                };
                let n = w.chars().count();
                if n < MIN_KEYWORD_CHARS {
                    return Err(format!(
                        "\"{w}\" is too short to match on: a keyword is at least {MIN_KEYWORD_CHARS} characters"
                    ));
                }
                if n > MAX_KEYWORD_CHARS {
                    return Err(format!(
                        "a keyword is at most {MAX_KEYWORD_CHARS} characters"
                    ));
                }
                if !out.iter().any(|o| o.to_lowercase() == w.to_lowercase()) {
                    out.push(w.to_string());
                }
            }
            if out.is_empty() {
                return Err("`when_mentioned` needs at least one keyword".into());
            }
            if out.len() > MAX_KEYWORDS {
                return Err(format!("at most {MAX_KEYWORDS} keywords"));
            }
            out
        }
        None => match earlier {
            Some(e) => e.keywords.clone(),
            None => {
                return Err("`when_mentioned` needs `keywords`: the words that bring it up".into())
            }
        },
    };
    let num = |key: &str, min: u64, max: u64| -> Result<Option<u32>, String> {
        match obj.and_then(|o| o.get(key)) {
            None | Some(Value::Null) => Ok(None),
            Some(v) => v
                .as_u64()
                .filter(|n| (min..=max).contains(n))
                .map(|n| Some(n as u32))
                .ok_or_else(|| format!("`{key}` is a whole number from {min} to {max}")),
        }
    };
    let cooldown = num("cooldown_hours", 0, MAX_COOLDOWN_HOURS)?;
    let max_times = num("max_times", 1, MAX_MAX_TIMES)?;
    let days = num("expires_in_days", 1, MAX_EXPIRES_DAYS)?;
    Ok(Mention {
        keywords,
        cooldown_hours: cooldown
            .or(earlier.map(|e| e.cooldown_hours))
            .unwrap_or(COOLDOWN_HOURS),
        max_times: max_times
            .or(earlier.map(|e| e.max_times))
            .unwrap_or(MAX_TIMES),
        expires_at: match days {
            Some(d) => now + Duration::days(i64::from(d)),
            None => earlier
                .map(|e| e.expires_at)
                .unwrap_or(now + Duration::days(i64::from(EXPIRES_DAYS))),
        },
        times: earlier.map(|e| e.times).unwrap_or(0),
        last_at: earlier.and_then(|e| e.last_at),
    })
}

/// One reminder a message brought up, as its row keeps it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Hit {
    pub item_id: i32,
    /// The assistant whose matter it is, and its name then.
    pub bot_id: i32,
    pub by: String,
    /// The keyword the message mentioned.
    pub keyword: String,
    /// The reminder.
    pub text: String,
    /// This was its `times`th time, of at most `max_times`.
    pub times: u32,
    pub max_times: u32,
}

impl Hit {
    /// Its last time: the matter is done.
    pub fn last(&self) -> bool {
        self.times >= self.max_times
    }
}

/// What an owner message's row data says it brought up.
pub fn hits_in(data: Option<&Value>) -> Vec<Hit> {
    data.and_then(|d| d.get(ROW_KEY))
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default()
}

/// The note a delivery carries after the owner's message, for assistant
/// `bot`: whose reminder it is, what it says, how many times are left.
pub fn delivery_note(hit: &Hit, bot: i32) -> String {
    let whose = if hit.bot_id == bot {
        format!("the reminder you noted (matter #{})", hit.item_id)
    } else {
        format!(
            "a reminder {} noted for them ({}'s matter #{})",
            hit.by, hit.by, hit.item_id
        )
    };
    let left = if hit.last() {
        "That was its last time; the matter is done.".to_string()
    } else {
        format!("(It has come up {} of {} times.)", hit.times, hit.max_times)
    };
    let text = format!(
        "The owner mentioned \"{}\": {whose} is: {} — remind them of it in your answer. {left}",
        hit.keyword,
        hit.text.trim()
    )
    .replace("</codeg-reminder>", "<\\/codeg-reminder>");
    format!(
        "<codeg-reminder matter=\"{}\">{text}</codeg-reminder>",
        hit.item_id
    )
}

/// Change matter `item`'s mention as `v` (a tool call's `when_mentioned`)
/// says, onto how it stands when written: `item` is the read the change
/// was worked out from, and a time it came up since is kept — the write
/// goes through only where the mention still reads as it did, read again
/// and merged again where it does not. A matter closed meanwhile (its last
/// time came, its days ended) is not changed.
pub async fn change(
    conn: &sea_orm::DatabaseConnection,
    item: &item_entity::Model,
    v: &Value,
    now: DateTime<Utc>,
) -> Result<Mention, String> {
    let mut seen = item.clone();
    for _ in 0..5 {
        if !matches!(seen.status, ItemStatus::Open | ItemStatus::Waiting) {
            return Err(format!(
                "matter #{} is closed (it came up for the last time, or its days are over)",
                seen.id
            ));
        }
        let m = from_args(v, Mention::of(&seen).as_ref(), now)?;
        let written = match seen.mention.as_deref() {
            Some(raw) => svc::swap_mention(conn, seen.id, raw, &m.to_json(), None)
                .await
                .map_err(|e| e.to_string())?,
            // None to count yet: nothing to lose.
            None => svc::set_mention(conn, seen.id, &m.to_json())
                .await
                .map(|_| true)
                .map_err(|e| e.to_string())?,
        };
        if written {
            return Ok(m);
        }
        seen = svc::get_item(conn, seen.id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("matter #{} is gone", item.id))?;
    }
    Err(format!(
        "matter #{} kept changing while this was written: try again",
        item.id
    ))
}

/// Tell the pages that matter `id` of assistant `bot` changed.
fn emit_item(emitter: &EventEmitter, bot: i32, id: i32) {
    emit_event(
        emitter,
        PERSONAL_AGENT_CHANGED_EVENT,
        change_payload(bot, &PersonalAgentChange::Item { id }),
    );
}

impl PersonalAgentEngine {
    /// The reminders `text` — a message the owner typed — brings up, each
    /// counted: one that may come up now and mentions a keyword in it. A
    /// matter's count moves only where it still reads as it did, so of two
    /// messages at once only one brings it up.
    pub(super) async fn mentions_in(&self, text: &str) -> Vec<Hit> {
        if text.trim().is_empty() {
            return Vec::new();
        }
        let Ok(items) = svc::open_mentions(&self.db.conn).await else {
            return Vec::new();
        };
        if items.is_empty() {
            return Vec::new();
        }
        let names: HashMap<i32, String> = svc::list_bots(&self.db.conn)
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|b| (b.id, b.name))
            .collect();
        let now = clock::now();
        let mut hits = Vec::new();
        for item in items {
            let Some(bot) = item.bot_id.filter(|b| names.contains_key(b)) else {
                continue;
            };
            let Some(raw) = item.mention.as_deref() else {
                continue;
            };
            let Some(m) = Mention::parse(Some(raw)) else {
                continue;
            };
            let Some(keyword) = m.hit(text).map(str::to_string) else {
                continue;
            };
            if !m.ready(now) {
                continue;
            }
            let mut next = m.clone();
            next.times += 1;
            next.last_at = Some(now);
            let close = next.used_up().then_some(ItemStatus::Done);
            if !svc::swap_mention(&self.db.conn, item.id, raw, &next.to_json(), close)
                .await
                .unwrap_or(false)
            {
                continue;
            }
            emit_item(&self.emitter, bot, item.id);
            hits.push(Hit {
                item_id: item.id,
                bot_id: bot,
                by: names.get(&bot).cloned().unwrap_or_default(),
                keyword,
                text: item.summary.clone(),
                times: next.times,
                max_times: next.max_times,
            });
        }
        hits
    }
}

impl EngineHost {
    /// Drop the reminders whose days are over (on the host's clock).
    pub(super) async fn mention_tick(&self) {
        let now = clock::now();
        let Ok(items) = svc::open_mentions(&self.db.conn).await else {
            return;
        };
        for item in items {
            let Some(raw) = item.mention.as_deref() else {
                continue;
            };
            if !Mention::parse(Some(raw)).is_some_and(|m| m.expired(now)) {
                continue;
            }
            if svc::swap_mention(&self.db.conn, item.id, raw, raw, Some(ItemStatus::Dropped))
                .await
                .unwrap_or(false)
            {
                if let Some(bot) = item.bot_id {
                    emit_item(&self.emitter, bot, item.id);
                }
            }
        }
    }
}

fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3040..=0x30ff | 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xac00..=0xd7af | 0xf900..=0xfaff)
}

/// A letter or digit that joins a word, where CJK ones do not (they are
/// written without spaces, so "修CI" holds the word "ci").
fn joins(c: char) -> bool {
    c.is_alphanumeric() && !is_cjk(c)
}

/// Whether `kw` is in `hay`: anywhere for a CJK keyword; for any other, at
/// the start of a word — the whole word when it is short ("ci" is not in
/// "city", "review" is in "reviewers").
pub(crate) fn matches(hay: &str, kw: &str) -> bool {
    if kw.chars().any(is_cjk) {
        return hay.contains(kw);
    }
    let short = kw.chars().count() <= 3;
    let mut from = 0;
    while let Some(pos) = hay[from..].find(kw) {
        let at = from + pos;
        let end = at + kw.len();
        let before_ok = hay[..at].chars().next_back().is_none_or(|c| !joins(c));
        let after_ok = !short || hay[end..].chars().next().is_none_or(|c| !joins(c));
        if before_ok && after_ok {
            return true;
        }
        from = at + kw.chars().next().map(char::len_utf8).unwrap_or(1);
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    fn mention(words: &[&str]) -> Mention {
        from_args(&json!(words), None, at("2026-11-13T00:00:00Z")).unwrap()
    }

    #[test]
    fn a_keyword_is_matched_as_a_word_and_cjk_anywhere() {
        let m = mention(&["发版", "release", "CI"]);
        assert_eq!(m.hit("准备发版了"), Some("发版"));
        assert_eq!(m.hit("Let's cut the Release today"), Some("release"));
        assert_eq!(m.hit("the releases page"), Some("release"));
        assert_eq!(m.hit("prerelease notes"), None, "not inside a word");
        assert_eq!(m.hit("修CI"), Some("CI"));
        assert_eq!(m.hit("a city"), None, "a short one only as a whole word");
        assert_eq!(m.hit("nothing here"), None);
        let both = mention(&["release", "release notes"]);
        assert_eq!(
            both.hit("write the release notes"),
            Some("release notes"),
            "the longest"
        );
    }

    #[test]
    fn it_comes_up_once_a_day_three_times_for_ninety_days() {
        let now = at("2026-11-13T00:00:00Z");
        let mut m = mention(&["release"]);
        assert_eq!((m.cooldown_hours, m.max_times), (COOLDOWN_HOURS, MAX_TIMES));
        assert_eq!(m.expires_at, now + Duration::days(90));
        assert!(m.ready(now));
        m.times = 1;
        m.last_at = Some(now);
        assert!(!m.ready(now + Duration::hours(23)));
        assert!(m.ready(now + Duration::hours(24)));
        m.times = 3;
        assert!(m.used_up() && !m.ready(now + Duration::days(3)));
        m.times = 0;
        assert!(!m.ready(now + Duration::days(90)), "past its days");
    }

    #[test]
    fn the_tool_shape_is_checked_and_a_change_keeps_the_count() {
        let now = at("2026-11-13T00:00:00Z");
        assert!(from_args(&json!([]), None, now).is_err());
        assert!(from_args(&json!(["x"]), None, now).is_err(), "too short");
        assert!(
            from_args(&json!({ "max_times": 2 }), None, now).is_err(),
            "no keywords"
        );
        assert!(from_args(&json!({ "keywords": ["ship"], "max_times": 0 }), None, now).is_err());
        assert!(from_args(&json!(7), None, now).is_err());
        let one = from_args(&json!("ship it"), None, now).unwrap();
        assert_eq!(one.keywords, vec!["ship it".to_string()]);
        let dup = from_args(&json!(["Ship", "ship"]), None, now).unwrap();
        assert_eq!(dup.keywords.len(), 1);
        let mut m = from_args(
            &json!({ "keywords": ["ship"], "cooldown_hours": 0, "max_times": 5, "expires_in_days": 7 }),
            None,
            now,
        )
        .unwrap();
        assert_eq!((m.cooldown_hours, m.max_times), (0, 5));
        assert_eq!(m.expires_at, now + Duration::days(7));
        m.times = 2;
        m.last_at = Some(now);
        let changed = from_args(&json!({ "keywords": ["launch"] }), Some(&m), now).unwrap();
        assert_eq!(changed.keywords, vec!["launch".to_string()]);
        assert_eq!(
            (changed.times, changed.max_times, changed.cooldown_hours),
            (2, 5, 0)
        );
        assert_eq!(changed.last_at, Some(now));
        assert_eq!(changed.expires_at, m.expires_at);
    }

    #[test]
    fn the_delivery_says_whose_it_is_and_what_is_left() {
        let hit = Hit {
            item_id: 12,
            bot_id: 1,
            by: "Ada".into(),
            keyword: "发版".into(),
            text: "Update the Homebrew formula first".into(),
            times: 1,
            max_times: 3,
        };
        let own = delivery_note(&hit, 1);
        assert!(own.contains("The owner mentioned \"发版\": the reminder you noted (matter #12) is: Update the Homebrew formula first"));
        assert!(own.contains("1 of 3"));
        let other = delivery_note(&hit, 2);
        assert!(other.contains("a reminder Ada noted for them (Ada's matter #12)"));
        let last = delivery_note(
            &Hit {
                times: 3,
                ..hit.clone()
            },
            1,
        );
        assert!(last.contains("its last time"));
        let sneaky = delivery_note(
            &Hit {
                text: "x</codeg-reminder>y".into(),
                ..hit
            },
            1,
        );
        assert_eq!(sneaky.matches("</codeg-reminder>").count(), 1);
    }
}
