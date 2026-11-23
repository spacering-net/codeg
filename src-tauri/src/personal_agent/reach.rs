//! Reaching the owner (6.2, 8.6, 10.10; 1.13): what of the assistants' news
//! becomes a notification, when, and how it is delivered.
//!
//! **Only three times.** codeg reaches out when something is stuck on the
//! owner, ready, or done — and with their reminders. Each kind of news
//! ([`NEWS`]) has a level the owner can change; low news never interrupts.
//!
//! - **Stuck on them**: what the roster's live state finds waiting
//!   ([`EngineHost::reach_needs`]): an assistant's own permission request
//!   (urgent), a question forwarded from work it dispatched (urgent), its own
//!   question or choice card, a card to confirm, a step not known to have
//!   happened, a stopped exchange (normal). Dispatched work waiting on its
//!   own session — whose window already said so — and any other session in
//!   codeg are told once they have waited [`NUDGE_AFTER_MINS`] minutes.
//! - **Done / ready**: dispatched work finished, failed or waiting for review;
//!   the reply to what the owner asked.
//! - Their **reminders**, at the level they set, through mute and quiet hours.
//!
//! **Routing** ([`decide`]): an assistant hidden, muted or with "notify me"
//! off is silent; one the owner is looking at is not interrupted; with
//! `proactive` off only reminders go. In quiet hours only reminders (and,
//! if the owner said so, urgent news) go; the rest waits until the owner is
//! back after them. Urgent goes at once. Normal goes at once while the owner
//! is here and not typing; while they type it waits until they have stopped
//! `focus_wait` minutes; while they are away it waits for their return and
//! goes merged ("while you were away"). Low goes nowhere, or merged at most
//! every [`DIGEST_EVERY_HOURS`] hours. The same news is told once.
//!
//! **Delivery.** While a codeg window has the focus, the page shows it
//! (`toast`). Otherwise the desktop posts a system notification itself —
//! under codeg's general switch and "hide contents", which the page syncs
//! ([`set_gate`]) — and asks the Dock / taskbar for the urgent; the server
//! leaves it to its open pages (`system`), one of which shows it. Every one
//! goes out on [`PERSONAL_AGENT_NOTIFY_EVENT`]. The title is the
//! assistant's name; the body's last line says why now.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Mutex, RwLock};

use chrono::{DateTime, Duration, NaiveTime, Timelike, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::clock;
use super::host::EngineHost;
use super::presence::{self, Attending, Hours};
use crate::db::entities::personal_agent::{self as agent_entity, BotKind};
use crate::db::service::personal_agent_service as svc;
use crate::models::personal_agent_prefs::{
    clock_of, AccountView, Level, LowVia, NormalVia, Prefs, QuietHours, QuietLets, UrgentVia,
    DEFAULT_QUIET_FROM, DEFAULT_QUIET_TO,
};
use crate::models::personal_agent_roster::NeedsYou;
use crate::models::system::AppLocale;
use crate::web::event_bridge::emit_event;

pub use crate::models::personal_agent_prefs::NEWS;

/// Every notification, to the pages.
pub const PERSONAL_AGENT_NOTIFY_EVENT: &str = "personal-agent://notify";
/// What has waited on the owner this long without a word is told once.
pub const NUDGE_AFTER_MINS: i64 = 10;
/// Low news is merged at most this often.
pub const DIGEST_EVERY_HOURS: i64 = 2;
/// The news remembered as told; the oldest goes.
const TOLD_MAX: usize = 4096;
/// The longest a line of news gets.
const TEXT_CHARS: usize = 140;
/// The lines of a merged notification.
const MERGED_LINES: usize = 3;
/// Where codeg keeps the page's switches over the notifications it posts.
const GATE_KEY: &str = "notification_gate";

// ── what the page sees ──────────────────────────────────────────────────────

/// Where a notification takes the owner.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NotifyLink {
    /// An assistant's conversation, at a row.
    Bot { bot_id: i32, row_id: Option<i32> },
    Conversation {
        conversation_id: i32,
        folder_id: Option<i32>,
    },
}

/// Who shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// The page, in the window that has the focus.
    Toast,
    /// One open page, as a system notification.
    System,
    /// The desktop posted it already.
    Posted,
}

/// One notification, as [`PERSONAL_AGENT_NOTIFY_EVENT`] carries it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Notify {
    pub id: String,
    pub mode: Mode,
    pub level: Level,
    pub bot_id: Option<i32>,
    pub title: String,
    pub body: String,
    /// The body, when the owner hides notification contents.
    pub hidden_body: String,
    /// Ask the Dock / taskbar for the owner.
    pub attention: bool,
    /// The owner wants it on the page only: never a system notification.
    pub in_page: bool,
    pub link: Option<NotifyLink>,
    pub avatar: Option<Value>,
}

// ── the news ────────────────────────────────────────────────────────────────

/// What a piece of news says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum What {
    /// A reminder, and the time it was set for (`HH:MM`).
    Reminder {
        text: String,
        at: String,
    },
    Waiting {
        text: String,
    },
    Approval {
        text: String,
    },
    /// Waiting on the owner this many minutes.
    WaitedLong {
        text: String,
        minutes: i64,
    },
    /// A session of codeg's (not an assistant's) waiting this long.
    Session {
        text: String,
        minutes: i64,
    },
    Done {
        text: String,
    },
    Failed {
        text: String,
    },
    Review {
        text: String,
    },
    /// Accepted by its assistant: it can be merged (7.5).
    Accepted {
        text: String,
    },
    /// Accepted, delivered as a pull request.
    AcceptedPr {
        text: String,
    },
    /// Accepted and merged; a pull request an assistant merged.
    Merged {
        text: String,
    },
    /// A comment an assistant posted on a forge (7.4).
    Commented {
        text: String,
    },
    /// An issue an assistant closed.
    IssueClosed {
        text: String,
    },
    /// The acceptance is the owner's call.
    AcceptAsk {
        text: String,
    },
    /// Sent back as many rounds as allowed, still not accepted.
    UsedUp {
        text: String,
    },
    /// The worktree changed during or after its check.
    AcceptVoid {
        text: String,
    },
    /// A watched pull request (7.4): its checks failed.
    PrFailed {
        text: String,
    },
    /// Green again after failing, short of mergeable.
    PrPassed {
        text: String,
    },
    PrConflict {
        text: String,
    },
    /// Its checks green and the forge would merge it.
    PrReady {
        text: String,
    },
    /// No conflict, its checks unknown (CNB).
    PrNoConflict {
        text: String,
    },
    PrClosed {
        text: String,
    },
    /// Fixed as many rounds as the owner allows, its checks still failing.
    PrGaveUp {
        text: String,
        rounds: u32,
    },
    /// A routine's report: its title, and the reply's first words.
    RoutineReport {
        title: String,
        text: Option<String>,
    },
    /// A routine codeg paused.
    RoutinePaused {
        text: String,
    },
    /// One of codeg's proposal rules (6.7) found something: which, and
    /// what it is about.
    Rule {
        rule: String,
        text: String,
    },
    /// The morning brief is ready: how many things wait on the owner.
    Brief {
        needs: usize,
    },
    /// The day's wrap-up: how many things need the owner tomorrow.
    Wrap {
        needs: usize,
    },
    /// An assistant changed what it remembers (7.7): the entries by title,
    /// and whether its persona, its rules or the owner's profile changed.
    Memory {
        titles: Vec<String>,
        soul: bool,
        rules: bool,
        user: bool,
    },
    /// An assistant's nightly tidy-up of its memory (7.7): the entries it
    /// touched, and whether its persona, rules or the owner's profile were
    /// among them — and whether it is a draft for the owner.
    Tidy {
        titles: Vec<String>,
        soul: bool,
        rules: bool,
        user: bool,
        draft: bool,
    },
    /// A process skill an assistant wrote, changed or removed (7.8): its
    /// title, `added` / `modified` / `deleted`, and whether it is a draft.
    Skill {
        title: String,
        status: String,
        draft: bool,
    },
    /// A check of a message the owner asked for came back (10.3): its
    /// verdict (none: it did not finish), and what it checked.
    Check {
        verdict: Option<crate::db::entities::personal_agent_check::FactVerdict>,
        text: String,
    },
    /// A plan carried out to its end (7.6): its title.
    PlanDone {
        text: String,
    },
    /// A plan stuck on a step: its title and the step's.
    PlanStuck {
        text: String,
    },
    /// The reply's first words (none: it said nothing in words).
    Reply {
        text: Option<String>,
    },
    Plain {
        text: String,
    },
}

/// One piece of news for the owner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct News {
    /// Its identity: the same news is told once.
    pub key: String,
    pub bot_id: i32,
    /// One of [`NEWS`].
    pub kind: &'static str,
    pub what: What,
    pub link: Option<NotifyLink>,
    /// The need it stands for: once that is gone, what waited is not told.
    pub need: Option<String>,
}

/// A line of news, cut to fit.
pub fn glimpse(text: &str) -> String {
    let line = text
        .lines()
        .map(|l| {
            l.trim()
                .trim_start_matches(['#', '>', '-', '*', '•'])
                .replace("**", "")
                .replace('`', "")
                .trim()
                .to_string()
        })
        .find(|l| !l.is_empty())
        .unwrap_or_default();
    let mut out: String = line.chars().take(TEXT_CHARS).collect();
    if line.chars().count() > TEXT_CHARS {
        out.push('…');
    }
    out
}

/// A reply's first words, or `None` when it opens with no words (a card,
/// code).
pub fn reply_glimpse(text: &str) -> Option<String> {
    let first = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    if first.starts_with("```") || first.starts_with('{') || first.starts_with('<') {
        return None;
    }
    Some(glimpse(text)).filter(|s| !s.is_empty())
}

// ── routing ─────────────────────────────────────────────────────────────────

/// What becomes of a piece of news.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// Not a notification: the roster and "today" show it.
    Drop,
    /// Now: on the page only, or a notification (asking for the owner).
    Now { in_page: bool, attention: bool },
    /// When the owner has stopped typing.
    HoldFocus,
    /// When the owner is back (after their quiet hours).
    HoldAway,
    /// Into the next merged notification of low news.
    Digest,
}

/// An assistant's switches over its notifications (4.14, 10.10).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct BotSwitches {
    pub hidden: bool,
    pub muted: bool,
    pub notify: bool,
}

impl BotSwitches {
    pub fn of(row: &agent_entity::Model) -> Self {
        Self {
            hidden: row.hidden,
            muted: row.muted,
            notify: row.notify,
        }
    }

    fn silent(self) -> bool {
        self.hidden || self.muted || !self.notify
    }
}

/// Where news of `kind` goes, from the owner's preferences, the
/// assistant's switches, whether the owner is looking at it, where they
/// are, and whether it is their quiet time.
pub fn decide(
    prefs: &Prefs,
    kind: &str,
    switches: BotSwitches,
    viewed: bool,
    att: &Attending,
    quiet: bool,
    now: DateTime<Utc>,
) -> Route {
    // Their reminders are theirs: through mute and quiet hours.
    let reminder = kind == "reminder";
    // A brief or a wrap-up is brought to the owner when they are here: their
    // quiet hours are over for them then (6.4).
    let summary = kind == "brief" && att.present;
    if !reminder && switches.silent() {
        return Route::Drop;
    }
    if viewed {
        return Route::Drop;
    }
    if !reminder && !prefs.proactive() {
        return Route::Drop;
    }
    let level = prefs.level_of(kind);
    if quiet && !summary {
        let lets = reminder || (prefs.quiet_lets == QuietLets::Urgent && level == Level::Urgent);
        if !lets {
            return if level == Level::Low {
                Route::Drop
            } else {
                Route::HoldAway
            };
        }
    }
    match level {
        Level::Urgent => match prefs.urgent_via {
            UrgentVia::SystemAttention => Route::Now {
                in_page: false,
                attention: true,
            },
            UrgentVia::System => Route::Now {
                in_page: false,
                attention: false,
            },
            UrgentVia::InPage => Route::Now {
                in_page: true,
                attention: false,
            },
        },
        Level::Normal => match prefs.normal_via {
            NormalVia::Today => Route::Drop,
            NormalVia::InPage => Route::Now {
                in_page: true,
                attention: false,
            },
            NormalVia::System if !att.present => Route::HoldAway,
            NormalVia::System if holds_for_typing(prefs, att, now) => Route::HoldFocus,
            NormalVia::System => Route::Now {
                in_page: false,
                attention: false,
            },
        },
        Level::Low => match prefs.low_via {
            LowVia::Today => Route::Drop,
            LowVia::Digest => Route::Digest,
        },
    }
}

/// The owner is at work typing, and what can wait waits: they typed within
/// the last two minutes, or within `focus_wait` minutes when that is longer
/// — so it goes once they have stopped that long.
pub fn holds_for_typing(prefs: &Prefs, att: &Attending, now: DateTime<Utc>) -> bool {
    if prefs.focus_wait == 0 || !att.present {
        return false;
    }
    let window = (prefs.focus_wait as i64 * 60).max(presence::PRESENT_WITHIN_SECS);
    att.last_typed
        .is_some_and(|t| (now - t).num_seconds() < window)
}

fn within(t: NaiveTime, from: NaiveTime, to: NaiveTime) -> bool {
    if from == to {
        false
    } else if from < to {
        t >= from && t < to
    } else {
        t >= from || t < to
    }
}

fn hm(s: &str) -> NaiveTime {
    clock_of(s).unwrap_or(NaiveTime::MIN)
}

/// Whether `now` is in the owner's quiet hours.
pub fn is_quiet(prefs: &Prefs, hours: &Hours, tz: Tz, now: DateTime<Utc>) -> bool {
    let local = now.with_timezone(&tz);
    let t = local.time();
    let defaults = || within(t, hm(DEFAULT_QUIET_FROM), hm(DEFAULT_QUIET_TO));
    match prefs.quiet_hours {
        QuietHours::None => false,
        QuietHours::Fixed => within(t, hm(&prefs.quiet_from), hm(&prefs.quiet_to)),
        QuietHours::Auto => {
            let day = presence::hours_day(now, tz);
            let d = hours.on(day);
            if !d.learned || d.start >= d.end {
                return defaults();
            }
            // Minutes into the owner's day: the small hours are its evening's.
            let mut m = local.hour() * 60 + local.minute();
            if local.date_naive() != day {
                m += 24 * 60;
            }
            m < d.start || m >= d.end
        }
    }
}

// ── the words ───────────────────────────────────────────────────────────────

/// A notification's words in one language. `{text}`, `{n}` and `{time}`
/// are filled in.
struct Words {
    primary: &'static str,
    waiting: &'static str,
    approval: &'static str,
    waited: &'static str,
    session: &'static str,
    done: &'static str,
    failed: &'static str,
    review: &'static str,
    reply_empty: &'static str,
    reminder: &'static str,
    away: &'static str,
    batch: &'static str,
    digest: &'static str,
    more: &'static str,
    assistants: &'static str,
    hidden: &'static str,
    why_reminder: &'static str,
    why_forwarded: &'static str,
    why_approval: &'static str,
    why_question: &'static str,
    why_confirm: &'static str,
    why_stuck: &'static str,
    why_waiting: &'static str,
    why_done: &'static str,
    why_reply: &'static str,
    accepted: &'static str,
    accepted_pr: &'static str,
    merged: &'static str,
    commented: &'static str,
    issue_closed: &'static str,
    accept_ask: &'static str,
    used_up: &'static str,
    accept_void: &'static str,
    why_acceptance: &'static str,
    why_used_up: &'static str,
    why_forge: &'static str,
    pr_failed: &'static str,
    pr_passed: &'static str,
    pr_conflict: &'static str,
    pr_ready: &'static str,
    pr_no_conflict: &'static str,
    pr_closed: &'static str,
    pr_gave_up: &'static str,
    why_pr_gave_up: &'static str,
    why_pr_merged: &'static str,
    why_pr_cnb: &'static str,
    why_pr: &'static str,
    why_pr_ready: &'static str,
    routine: &'static str,
    routine_paused: &'static str,
    why_routine: &'static str,
    why_routine_paused: &'static str,
    rule_failed: &'static str,
    rule_review: &'static str,
    rule_pr_review: &'static str,
    rule_uncommitted: &'static str,
    rule_idle: &'static str,
    rule_behind: &'static str,
    why_proposal: &'static str,
    why_proposal_low: &'static str,
    brief: &'static str,
    brief_none: &'static str,
    wrap: &'static str,
    wrap_none: &'static str,
    why_brief: &'static str,
    why_wrap: &'static str,
    memory: &'static str,
    memory_soul: &'static str,
    memory_rules: &'static str,
    memory_user: &'static str,
    tidied: &'static str,
    tidied_draft: &'static str,
    skill_added: &'static str,
    skill_changed: &'static str,
    skill_removed: &'static str,
    skill_draft: &'static str,
    check_true: &'static str,
    check_false: &'static str,
    check_partly: &'static str,
    check_unsure: &'static str,
    check_unfinished: &'static str,
    check_title: &'static str,
    why_memory: &'static str,
    plan_done: &'static str,
    plan_stuck: &'static str,
    why_plan: &'static str,
    why_plan_stuck: &'static str,
}

const EN: Words = Words {
    primary: "Personal agent",
    waiting: "Waiting for you: {text}",
    approval: "Waiting for your approval: {text}",
    waited: "Waiting for you for {n} min: {text}",
    session: "A session has waited for you {n} min: {text}",
    done: "Done: {text}",
    failed: "Didn't get done: {text}",
    review: "Ready for your review: {text}",
    reply_empty: "Open codeg to see what it did",
    reminder: "Reminder: {text}",
    away: "While you were away — {n} things",
    batch: "{n} things for you",
    digest: "{n} updates",
    more: "…and {n} more",
    assistants: "Your assistants",
    hidden: "Open codeg to see it",
    why_reminder: "You asked to be reminded at {time}.",
    why_forwarded: "Work it dispatched is asking, and it couldn't answer for you.",
    why_approval: "It can't go on until you approve.",
    why_question: "It needs your answer to go on.",
    why_confirm: "You asked to confirm these first.",
    why_stuck: "It needs you to decide what happens next.",
    why_waiting: "No one has answered it yet.",
    why_done: "It dispatched this work for you.",
    why_reply: "You asked it.",
    accepted: "Ready to merge: {text}",
    accepted_pr: "Accepted: {text}",
    merged: "Merged: {text}",
    commented: "Commented on {text}",
    issue_closed: "Closed {text}",
    accept_ask: "Your call on its acceptance: {text}",
    used_up: "Still not right after the rounds allowed: {text}",
    accept_void: "Its check no longer applies: {text}",
    why_acceptance: "It checked the work it dispatched for you.",
    why_used_up: "It sent the work back as many times as you allow.",
    why_forge: "It did this on a forge for you.",
    pr_failed: "Checks failed: {text}",
    pr_passed: "Checks green again: {text}",
    pr_conflict: "Has a conflict: {text}",
    pr_ready: "Ready to merge: {text}",
    pr_no_conflict: "No conflict, checks unknown: {text}",
    pr_closed: "Closed without merging: {text}",
    pr_gave_up: "Fixed {n} times, still failing: {text}",
    why_pr_gave_up: "codeg fixed it as many times as you allow; it's yours now.",
    why_pr_merged: "Its checks were green, so codeg merged it.",
    why_pr_cnb: "CNB shows no checks; it's merged once you approve.",
    why_pr: "It watches this pull request for you.",
    why_pr_ready: "Its checks are green and the forge can merge it.",
    routine: "Routine report: {text}",
    routine_paused: "Routine paused: {text}",
    why_routine: "It ran a routine you set up.",
    why_routine_paused: "It failed three times in a row, or the agent its work runs on can't be used; it won't run until you look.",    rule_failed: "Failed, and nobody's on it: {text}",
    rule_review: "Waiting long for review: {text}",
    rule_pr_review: "Waiting for your review: {text}",
    rule_uncommitted: "Changes left uncommitted: {text}",
    rule_idle: "Gone quiet: {text}",
    rule_behind: "Behind its target, with conflicts: {text}",
    why_proposal: "codeg noticed it; the card has a next step.",
    why_proposal_low: "codeg noticed it; nothing urgent.",
    brief: "Good morning — {n} waiting on you",
    brief_none: "Good morning — your brief is ready",
    wrap: "The day's wrap-up — {n} for you tomorrow",
    wrap_none: "The day's wrap-up is ready",
    why_brief: "Your morning brief.",
    why_wrap: "Your usual end of day is near, or you asked for it.",
    memory: "Remembered: {text}",
    memory_soul: "persona",
    memory_rules: "rules",
    memory_user: "your profile",
    tidied: "Tidied its memory: {text}",
    tidied_draft: "Tidied its memory, as a draft for you: {text}",
    skill_added: "Wrote down a process: {text}",
    skill_changed: "Changed its process skill: {text}",
    skill_removed: "Removed its process skill: {text}",
    skill_draft: "A process skill for you to look at: {text}",
    check_true: "Check: true — {text}",
    check_false: "Check: not true — {text}",
    check_partly: "Check: partly true — {text}",
    check_unsure: "Check: can't tell — {text}",
    check_unfinished: "The check did not finish: {text}",
    check_title: "Check: {text}",
    why_memory: "It changed what it remembers; the card can undo it.",
    plan_done: "Plan done: {text}",
    plan_stuck: "Plan stuck: {text}",
    why_plan: "It carried out a plan it laid out for you.",
    why_plan_stuck: "A step failed and stayed failed; what doesn't wait on it goes on.",
};

const ZH_CN: Words = Words {
    primary: "个人助手",
    waiting: "正在等你：{text}",
    approval: "等你批准：{text}",
    waited: "已经等你 {n} 分钟：{text}",
    session: "有个会话已经等你 {n} 分钟：{text}",
    done: "做完了：{text}",
    failed: "没做成：{text}",
    review: "等你验收：{text}",
    reply_empty: "打开 codeg 看它做了什么",
    reminder: "提醒：{text}",
    away: "你离开时：{n} 件事",
    batch: "{n} 件事找你",
    digest: "{n} 条动态",
    more: "……还有 {n} 件",
    assistants: "你的助手",
    hidden: "打开 codeg 查看",
    why_reminder: "你说过 {time} 提醒你。",
    why_forwarded: "它派出的活在问，它没法替你答。",
    why_approval: "你批准了它才能继续。",
    why_question: "它要你答了才能继续。",
    why_confirm: "你说过这类事先问你。",
    why_stuck: "接下来怎么办要你定。",
    why_waiting: "还没有人回应。",
    why_done: "这是它替你派出的活。",
    why_reply: "这是你让它办的事。",
    accepted: "可以合并了：{text}",
    accepted_pr: "验收通过：{text}",
    merged: "已合并：{text}",
    commented: "已评论：{text}",
    issue_closed: "已关闭：{text}",
    accept_ask: "验收要你定：{text}",
    used_up: "退回几轮还没过：{text}",
    accept_void: "验收已失效：{text}",
    why_acceptance: "这是它替你派出、替你验收的活。",
    why_used_up: "已经退回到你允许的轮数。",
    why_forge: "这是它替你在代码平台上做的。",
    pr_failed: "检查没过：{text}",
    pr_passed: "检查又绿了：{text}",
    pr_conflict: "有冲突：{text}",
    pr_ready: "可以合并了：{text}",
    pr_no_conflict: "没有冲突，检查状态未知：{text}",
    pr_closed: "没合并就关了：{text}",
    pr_gave_up: "已经修了 {n} 次，还是没过：{text}",
    why_pr_gave_up: "codeg 已经按你允许的次数修过了，接下来交给你。",
    why_pr_merged: "检查全绿，codeg 直接合并了。",
    why_pr_cnb: "CNB 读不到检查，你批准了才合并。",
    why_pr: "这是它替你看护的 PR。",
    why_pr_ready: "检查全绿，平台也显示能合。",
    routine: "例程报告：{text}",
    routine_paused: "例程已暂停：{text}",
    why_routine: "你设的例程跑了一次。",
    why_routine_paused: "连续失败了 3 次，或者它干活用的智能体不能用了；你看过之前它不会再跑。",    rule_failed: "失败了，没人处理：{text}",
    rule_review: "等验收很久了：{text}",
    rule_pr_review: "等你评审：{text}",
    rule_uncommitted: "有改动没提交：{text}",
    rule_idle: "很久没动了：{text}",
    rule_behind: "落后目标分支且有冲突：{text}",
    why_proposal: "codeg 发现的，卡片上有下一步。",
    why_proposal_low: "codeg 发现的，不急。",
    brief: "早上好，{n} 件需要你",
    brief_none: "早上好，晨报准备好了",
    wrap: "今天的收尾：明天 {n} 件需要你",
    wrap_none: "今天的收尾好了",
    why_brief: "这是你的晨报。",
    why_wrap: "你快收工了，或者你让它收尾。",
    memory: "记住了：{text}",
    memory_soul: "人设",
    memory_rules: "规则",
    memory_user: "你的资料",
    tidied: "整理了记忆：{text}",
    tidied_draft: "整理了记忆，草稿等你看：{text}",
    skill_added: "整理成了流程技能：{text}",
    skill_changed: "改了流程技能：{text}",
    skill_removed: "删掉了流程技能：{text}",
    skill_draft: "有个流程技能等你看：{text}",
    check_true: "核查：属实——{text}",
    check_false: "核查：不属实——{text}",
    check_partly: "核查：部分属实——{text}",
    check_unsure: "核查：无法判断——{text}",
    check_unfinished: "核查没完成：{text}",
    check_title: "核查：{text}",
    why_memory: "它改了记忆，卡片上可以撤销。",
    plan_done: "计划完成：{text}",
    plan_stuck: "计划卡住了：{text}",
    why_plan: "它按为你拟的计划一步步做完了。",
    why_plan_stuck: "有一步失败了，助手也没能接着做下去；不依赖这一步的照常推进。",
};

const ZH_TW: Words = Words {
    primary: "個人助手",
    waiting: "正在等你：{text}",
    approval: "等你核准：{text}",
    waited: "已經等你 {n} 分鐘：{text}",
    session: "有個會話已經等你 {n} 分鐘：{text}",
    done: "做完了：{text}",
    failed: "沒做成：{text}",
    review: "等你驗收：{text}",
    reply_empty: "打開 codeg 看它做了什麼",
    reminder: "提醒：{text}",
    away: "你離開時：{n} 件事",
    batch: "{n} 件事找你",
    digest: "{n} 則動態",
    more: "……還有 {n} 件",
    assistants: "你的助手",
    hidden: "打開 codeg 查看",
    why_reminder: "你說過 {time} 提醒你。",
    why_forwarded: "它派出的工作在提問，它沒辦法替你回答。",
    why_approval: "你核准了它才能繼續。",
    why_question: "它需要你回答才能繼續。",
    why_confirm: "你說過這類事先問你。",
    why_stuck: "接下來怎麼辦要你決定。",
    why_waiting: "還沒有人回應。",
    why_done: "這是它替你派出的工作。",
    why_reply: "這是你請它辦的事。",
    accepted: "可以合併了：{text}",
    accepted_pr: "驗收通過：{text}",
    merged: "已合併：{text}",
    commented: "已留言：{text}",
    issue_closed: "已關閉：{text}",
    accept_ask: "驗收要你決定：{text}",
    used_up: "退回幾輪還沒通過：{text}",
    accept_void: "驗收已失效：{text}",
    why_acceptance: "這是它替你派出、替你驗收的工作。",
    why_used_up: "已經退回到你允許的輪數。",
    why_forge: "這是它替你在程式碼平台上做的。",
    pr_failed: "檢查沒過：{text}",
    pr_passed: "檢查又綠了：{text}",
    pr_conflict: "有衝突：{text}",
    pr_ready: "可以合併了：{text}",
    pr_no_conflict: "沒有衝突，檢查狀態未知：{text}",
    pr_closed: "沒合併就關了：{text}",
    pr_gave_up: "已經修了 {n} 次，還是沒過：{text}",
    why_pr_gave_up: "codeg 已經按你允許的次數修過了，接下來交給你。",
    why_pr_merged: "檢查全綠，codeg 直接合併了。",
    why_pr_cnb: "CNB 讀不到檢查，你批准了才合併。",
    why_pr: "這是它替你看護的 PR。",
    why_pr_ready: "檢查全綠，平台也顯示能合併。",
    routine: "例程報告：{text}",
    routine_paused: "例程已暫停：{text}",
    why_routine: "你設的例程跑了一次。",
    why_routine_paused: "連續失敗了 3 次，或者它做事用的智能體不能用了；你看過之前它不會再跑。",    rule_failed: "失敗了，沒人處理：{text}",
    rule_review: "等驗收很久了：{text}",
    rule_pr_review: "等你審查：{text}",
    rule_uncommitted: "有改動沒提交：{text}",
    rule_idle: "很久沒動了：{text}",
    rule_behind: "落後目標分支且有衝突：{text}",
    why_proposal: "codeg 發現的，卡片上有下一步。",
    why_proposal_low: "codeg 發現的，不急。",
    brief: "早安，{n} 件需要你",
    brief_none: "早安，晨報準備好了",
    wrap: "今天的收尾：明天 {n} 件需要你",
    wrap_none: "今天的收尾好了",
    why_brief: "這是你的晨報。",
    why_wrap: "你快收工了，或者你請它收尾。",
    memory: "記住了：{text}",
    memory_soul: "人設",
    memory_rules: "規則",
    memory_user: "你的資料",
    tidied: "整理了記憶：{text}",
    tidied_draft: "整理了記憶，草稿等你看：{text}",
    skill_added: "整理成了流程技能：{text}",
    skill_changed: "改了流程技能：{text}",
    skill_removed: "刪掉了流程技能：{text}",
    skill_draft: "有個流程技能等你看：{text}",
    check_true: "核查：屬實——{text}",
    check_false: "核查：不屬實——{text}",
    check_partly: "核查：部分屬實——{text}",
    check_unsure: "核查：無法判斷——{text}",
    check_unfinished: "核查沒完成：{text}",
    check_title: "核查：{text}",
    why_memory: "它改了記憶，卡片上可以撤銷。",
    plan_done: "計畫完成：{text}",
    plan_stuck: "計畫卡住了：{text}",
    why_plan: "它按為你擬的計畫一步步做完了。",
    why_plan_stuck: "有一步失敗了，助手也沒能接著做下去；不依賴這一步的照常推進。",
};

const JA: Words = Words {
    primary: "パーソナルエージェント",
    waiting: "あなたを待っています：{text}",
    approval: "承認を待っています：{text}",
    waited: "{n} 分間あなたを待っています：{text}",
    session: "セッションが {n} 分間あなたを待っています：{text}",
    done: "完了：{text}",
    failed: "完了できませんでした：{text}",
    review: "確認待ち：{text}",
    reply_empty: "codeg を開いて内容を確認してください",
    reminder: "リマインダー：{text}",
    away: "離席中に {n} 件",
    batch: "{n} 件のお知らせ",
    digest: "{n} 件の更新",
    more: "…ほか {n} 件",
    assistants: "あなたのアシスタント",
    hidden: "codeg を開いて確認してください",
    why_reminder: "{time} にリマインドするよう頼まれていました。",
    why_forwarded: "依頼した作業からの質問で、代わりに答えられませんでした。",
    why_approval: "承認されるまで先に進めません。",
    why_question: "回答がないと先に進めません。",
    why_confirm: "この種のことは先に確認するよう設定されています。",
    why_stuck: "次にどうするか決めてください。",
    why_waiting: "まだ誰も応答していません。",
    why_done: "あなたのために依頼した作業です。",
    why_reply: "あなたが頼んだことです。",
    accepted: "マージできます：{text}",
    accepted_pr: "受け入れ済み：{text}",
    merged: "マージしました：{text}",
    commented: "コメントしました：{text}",
    issue_closed: "クローズしました：{text}",
    accept_ask: "受け入れの判断をお願いします：{text}",
    used_up: "許可された回数を直しても通りません：{text}",
    accept_void: "確認が無効になりました：{text}",
    why_acceptance: "あなたの代わりに出した作業を受け入れ確認しました。",
    why_used_up: "許可された回数まで差し戻しました。",
    why_forge: "あなたの代わりにフォージ上で行いました。",
    pr_failed: "チェックが失敗：{text}",
    pr_passed: "チェックが再び成功：{text}",
    pr_conflict: "コンフリクトあり：{text}",
    pr_ready: "マージできます：{text}",
    pr_no_conflict: "コンフリクトなし、チェック状態は不明：{text}",
    pr_closed: "マージされずにクローズ：{text}",
    pr_gave_up: "{n} 回修正してもまだ失敗：{text}",
    why_pr_gave_up: "codeg は許可された回数まで修正しました。ここからはあなたの判断です。",
    why_pr_merged: "チェックがすべて通ったので、codeg がマージしました。",
    why_pr_cnb: "CNB ではチェックを読めないため、承認されてからマージします。",
    why_pr: "あなたの代わりに見守っている PR です。",
    why_pr_ready: "チェックがすべて成功し、プラットフォームでもマージできます。",
    routine: "ルーティンの報告：{text}",
    routine_paused: "ルーティンを一時停止しました：{text}",
    why_routine: "設定したルーティンが実行されました。",
    why_routine_paused: "3 回続けて失敗したか、作業に使うエージェントが使えなくなりました。確認するまで実行されません。",    rule_failed: "失敗したまま誰も対応していません：{text}",
    rule_review: "レビュー待ちが長くなっています：{text}",
    rule_pr_review: "あなたのレビュー待ち：{text}",
    rule_uncommitted: "コミットされていない変更：{text}",
    rule_idle: "しばらく動きがありません：{text}",
    rule_behind: "ターゲットより遅れていて競合があります：{text}",
    why_proposal: "codeg が気づきました。カードに次の一歩があります。",
    why_proposal_low: "codeg が気づきました。急ぎではありません。",
    brief: "おはようございます — 対応が必要なことが {n} 件",
    brief_none: "おはようございます — 朝のまとめができました",
    wrap: "今日のまとめ — 明日あなたが必要なことが {n} 件",
    wrap_none: "今日のまとめができました",
    why_brief: "あなたの朝のまとめです。",
    why_wrap: "いつもの終業時刻が近いか、まとめを頼まれました。",
    memory: "覚えました：{text}",
    memory_soul: "人格設定",
    memory_rules: "ルール",
    memory_user: "あなたのプロフィール",
    tidied: "記憶を整理しました：{text}",
    tidied_draft: "記憶を整理しました（下書きです）：{text}",
    skill_added: "手順をスキルにまとめました：{text}",
    skill_changed: "手順スキルを変更しました：{text}",
    skill_removed: "手順スキルを削除しました：{text}",
    skill_draft: "確認待ちの手順スキル：{text}",
    check_true: "確認結果：正しい — {text}",
    check_false: "確認結果：正しくない — {text}",
    check_partly: "確認結果：一部正しい — {text}",
    check_unsure: "確認結果：判断できない — {text}",
    check_unfinished: "確認が終わりませんでした：{text}",
    check_title: "確認：{text}",
    why_memory: "記憶を更新しました。カードから元に戻せます。",
    plan_done: "計画が完了しました：{text}",
    plan_stuck: "計画が止まっています：{text}",
    why_plan: "あなたのために立てた計画を最後までやり終えました。",
    why_plan_stuck: "失敗したステップがあり、アシスタントでも立て直せませんでした。それに依存しないステップは進みます。",
};

const KO: Words = Words {
    primary: "개인 에이전트",
    waiting: "기다리고 있어요: {text}",
    approval: "승인을 기다리고 있어요: {text}",
    waited: "{n}분째 기다리고 있어요: {text}",
    session: "세션이 {n}분째 기다리고 있어요: {text}",
    done: "완료: {text}",
    failed: "완료하지 못함: {text}",
    review: "검토 대기: {text}",
    reply_empty: "codeg를 열어 무엇을 했는지 확인하세요",
    reminder: "알림: {text}",
    away: "자리를 비운 동안 {n}건",
    batch: "{n}건의 소식",
    digest: "업데이트 {n}건",
    more: "…외 {n}건",
    assistants: "내 어시스턴트",
    hidden: "codeg를 열어 확인하세요",
    why_reminder: "{time}에 알려 달라고 하셨어요.",
    why_forwarded: "맡긴 작업이 묻고 있는데, 대신 답할 수 없었어요.",
    why_approval: "승인해야 계속할 수 있어요.",
    why_question: "답해 주셔야 계속할 수 있어요.",
    why_confirm: "이런 일은 먼저 확인받도록 설정하셨어요.",
    why_stuck: "다음에 어떻게 할지 정해 주세요.",
    why_waiting: "아직 아무도 응답하지 않았어요.",
    why_done: "대신 맡긴 작업이에요.",
    why_reply: "부탁하신 일이에요.",
    accepted: "병합할 수 있어요: {text}",
    accepted_pr: "검수 통과: {text}",
    merged: "병합됨: {text}",
    commented: "댓글 남김: {text}",
    issue_closed: "닫음: {text}",
    accept_ask: "검수 결정을 기다려요: {text}",
    used_up: "허용된 횟수만큼 고쳐도 통과하지 못했어요: {text}",
    accept_void: "검수가 무효가 되었어요: {text}",
    why_acceptance: "대신 맡긴 작업을 대신 검수했어요.",
    why_used_up: "허용하신 횟수만큼 되돌려 보냈어요.",
    why_forge: "대신 코드 플랫폼에서 처리했어요.",
    pr_failed: "검사 실패: {text}",
    pr_passed: "검사가 다시 통과: {text}",
    pr_conflict: "충돌 있음: {text}",
    pr_ready: "병합 가능: {text}",
    pr_no_conflict: "충돌 없음, 검사 상태 알 수 없음: {text}",
    pr_closed: "병합 없이 닫힘: {text}",
    pr_gave_up: "{n}번 고쳤지만 여전히 실패: {text}",
    why_pr_gave_up: "codeg가 허용된 횟수만큼 고쳤습니다. 이제 직접 봐 주세요.",
    why_pr_merged: "검사가 모두 통과해서 codeg가 병합했습니다.",
    why_pr_cnb: "CNB에서는 검사를 읽을 수 없어 승인해야 병합됩니다.",
    why_pr: "대신 지켜보는 PR이에요.",
    why_pr_ready: "검사가 모두 통과했고 플랫폼에서도 병합할 수 있어요.",
    routine: "루틴 보고: {text}",
    routine_paused: "루틴 일시 중지됨: {text}",
    why_routine: "설정한 루틴이 실행됐어요.",
    why_routine_paused: "3번 연속 실패했거나 작업에 쓰는 에이전트를 쓸 수 없어요. 확인하기 전까지 실행되지 않아요.",    rule_failed: "실패했는데 아무도 처리하지 않았어요: {text}",
    rule_review: "검토를 오래 기다리고 있어요: {text}",
    rule_pr_review: "검토를 기다리고 있어요: {text}",
    rule_uncommitted: "커밋하지 않은 변경 사항: {text}",
    rule_idle: "한동안 진행이 없어요: {text}",
    rule_behind: "대상 브랜치보다 뒤처져 있고 충돌이 있어요: {text}",
    why_proposal: "codeg가 발견했어요. 카드에 다음 단계가 있어요.",
    why_proposal_low: "codeg가 발견했어요. 급하지 않아요.",
    brief: "좋은 아침이에요 — {n}건이 당신을 기다려요",
    brief_none: "좋은 아침이에요 — 아침 브리핑이 준비됐어요",
    wrap: "오늘의 마무리 — 내일 {n}건이 당신을 기다려요",
    wrap_none: "오늘의 마무리가 준비됐어요",
    why_brief: "아침 브리핑이에요.",
    why_wrap: "평소 퇴근 시간이 다가왔거나, 마무리를 부탁하셨어요.",
    memory: "기억했어요: {text}",
    memory_soul: "페르소나",
    memory_rules: "규칙",
    memory_user: "당신의 프로필",
    tidied: "기억을 정리했어요: {text}",
    tidied_draft: "기억을 정리했어요(초안이에요): {text}",
    skill_added: "절차를 스킬로 정리했어요: {text}",
    skill_changed: "절차 스킬을 바꿨어요: {text}",
    skill_removed: "절차 스킬을 지웠어요: {text}",
    skill_draft: "확인할 절차 스킬이 있어요: {text}",
    check_true: "확인 결과: 사실 — {text}",
    check_false: "확인 결과: 사실 아님 — {text}",
    check_partly: "확인 결과: 일부 사실 — {text}",
    check_unsure: "확인 결과: 판단 불가 — {text}",
    check_unfinished: "확인이 끝나지 않았어요: {text}",
    check_title: "확인: {text}",
    why_memory: "기억을 바꿨어요. 카드에서 되돌릴 수 있어요.",
    plan_done: "계획 완료: {text}",
    plan_stuck: "계획이 막혔어요: {text}",
    why_plan: "당신을 위해 세운 계획을 끝까지 해냈어요.",
    why_plan_stuck: "실패한 단계를 어시스턴트도 이어가지 못했어요. 이 단계에 의존하지 않는 단계는 계속 진행돼요.",
};

const ES: Words = Words {
    primary: "Agente personal",
    waiting: "Te está esperando: {text}",
    approval: "Espera tu aprobación: {text}",
    waited: "Lleva {n} min esperándote: {text}",
    session: "Una sesión lleva {n} min esperándote: {text}",
    done: "Hecho: {text}",
    failed: "No se completó: {text}",
    review: "Listo para que lo revises: {text}",
    reply_empty: "Abre codeg para ver lo que hizo",
    reminder: "Recordatorio: {text}",
    away: "Mientras no estabas: {n} cosas",
    batch: "{n} cosas para ti",
    digest: "{n} novedades",
    more: "…y {n} más",
    assistants: "Tus asistentes",
    hidden: "Abre codeg para verlo",
    why_reminder: "Pediste que te lo recordara a las {time}.",
    why_forwarded: "El trabajo que encargó pregunta y no pudo responder por ti.",
    why_approval: "No puede seguir hasta que lo apruebes.",
    why_question: "Necesita tu respuesta para seguir.",
    why_confirm: "Pediste confirmar esto antes.",
    why_stuck: "Tienes que decidir qué sigue.",
    why_waiting: "Nadie ha respondido todavía.",
    why_done: "Es trabajo que encargó por ti.",
    why_reply: "Se lo pediste tú.",
    accepted: "Listo para fusionar: {text}",
    accepted_pr: "Aceptado: {text}",
    merged: "Fusionado: {text}",
    commented: "Comentado en {text}",
    issue_closed: "Cerrado: {text}",
    accept_ask: "Te toca decidir si se acepta: {text}",
    used_up: "Sigue sin estar bien tras las rondas permitidas: {text}",
    accept_void: "Su revisión ya no vale: {text}",
    why_acceptance: "Revisó el trabajo que encargó por ti.",
    why_used_up: "Lo devolvió tantas veces como permites.",
    why_forge: "Lo hizo en la forja por ti.",
    pr_failed: "Comprobaciones fallidas: {text}",
    pr_passed: "Comprobaciones en verde de nuevo: {text}",
    pr_conflict: "Tiene un conflicto: {text}",
    pr_ready: "Lista para fusionar: {text}",
    pr_no_conflict: "Sin conflictos, comprobaciones desconocidas: {text}",
    pr_closed: "Cerrada sin fusionar: {text}",
    pr_gave_up: "Corregido {n} veces y sigue fallando: {text}",
    why_pr_gave_up: "codeg lo corrigió tantas veces como permites; ahora te toca a ti.",
    why_pr_merged: "Sus comprobaciones estaban en verde, así que codeg lo fusionó.",
    why_pr_cnb: "CNB no muestra comprobaciones; se fusiona cuando lo apruebes.",
    why_pr: "Vigila esta pull request por ti.",
    why_pr_ready: "Sus comprobaciones están en verde y la forja puede fusionarla.",
    routine: "Informe de la rutina: {text}",
    routine_paused: "Rutina en pausa: {text}",
    why_routine: "Se ejecutó una rutina que configuraste.",
    why_routine_paused: "Falló tres veces seguidas o ya no se puede usar el agente con el que trabaja; no volverá a ejecutarse hasta que la revises.",    rule_failed: "Falló y nadie se ocupa: {text}",
    rule_review: "Lleva mucho esperando revisión: {text}",
    rule_pr_review: "Espera tu revisión: {text}",
    rule_uncommitted: "Cambios sin confirmar: {text}",
    rule_idle: "Sin movimiento hace tiempo: {text}",
    rule_behind: "Detrás de su rama destino, con conflictos: {text}",
    why_proposal: "codeg lo notó; la tarjeta tiene el siguiente paso.",
    why_proposal_low: "codeg lo notó; nada urgente.",
    brief: "Buenos días: {n} cosas te necesitan",
    brief_none: "Buenos días: tu resumen está listo",
    wrap: "Cierre del día: {n} cosas te necesitan mañana",
    wrap_none: "El cierre del día está listo",
    why_brief: "Tu resumen de la mañana.",
    why_wrap: "Se acerca tu hora habitual de terminar, o lo pediste.",
    memory: "Recordado: {text}",
    memory_soul: "personalidad",
    memory_rules: "reglas",
    memory_user: "tu perfil",
    tidied: "Ordenó su memoria: {text}",
    tidied_draft: "Ordenó su memoria, como borrador para ti: {text}",
    skill_added: "Anotó un proceso: {text}",
    skill_changed: "Cambió su habilidad de proceso: {text}",
    skill_removed: "Quitó su habilidad de proceso: {text}",
    skill_draft: "Una habilidad de proceso para que la revises: {text}",
    check_true: "Comprobado: cierto — {text}",
    check_false: "Comprobado: no es cierto — {text}",
    check_partly: "Comprobado: en parte cierto — {text}",
    check_unsure: "Comprobado: no se puede saber — {text}",
    check_unfinished: "La comprobación no terminó: {text}",
    check_title: "Comprobar: {text}",
    why_memory: "Cambió lo que recuerda; la tarjeta permite deshacerlo.",
    plan_done: "Plan terminado: {text}",
    plan_stuck: "Plan atascado: {text}",
    why_plan: "Llevó a cabo un plan que preparó para ti.",
    why_plan_stuck: "Un paso falló y siguió fallando; lo que no depende de él sigue adelante.",
};

const DE: Words = Words {
    primary: "Persönlicher Agent",
    waiting: "Wartet auf dich: {text}",
    approval: "Wartet auf deine Freigabe: {text}",
    waited: "Wartet seit {n} Min. auf dich: {text}",
    session: "Eine Sitzung wartet seit {n} Min. auf dich: {text}",
    done: "Erledigt: {text}",
    failed: "Nicht erledigt: {text}",
    review: "Bereit zur Prüfung: {text}",
    reply_empty: "Öffne codeg, um zu sehen, was es getan hat",
    reminder: "Erinnerung: {text}",
    away: "Während du weg warst: {n} Dinge",
    batch: "{n} Dinge für dich",
    digest: "{n} Neuigkeiten",
    more: "…und {n} weitere",
    assistants: "Deine Assistenten",
    hidden: "Öffne codeg, um es zu sehen",
    why_reminder: "Du wolltest um {time} erinnert werden.",
    why_forwarded: "Die vergebene Arbeit fragt, und es konnte nicht für dich antworten.",
    why_approval: "Es kann erst weitermachen, wenn du zustimmst.",
    why_question: "Es braucht deine Antwort, um weiterzumachen.",
    why_confirm: "Du wolltest so etwas vorher bestätigen.",
    why_stuck: "Du musst entscheiden, wie es weitergeht.",
    why_waiting: "Bisher hat niemand geantwortet.",
    why_done: "Diese Arbeit hat es für dich vergeben.",
    why_reply: "Du hast es darum gebeten.",
    accepted: "Bereit zum Mergen: {text}",
    accepted_pr: "Abgenommen: {text}",
    merged: "Gemergt: {text}",
    commented: "Kommentiert: {text}",
    issue_closed: "Geschlossen: {text}",
    accept_ask: "Du entscheidest über die Abnahme: {text}",
    used_up: "Nach den erlaubten Runden noch nicht richtig: {text}",
    accept_void: "Die Prüfung gilt nicht mehr: {text}",
    why_acceptance: "Es hat die Arbeit geprüft, die es für dich vergeben hat.",
    why_used_up: "Es hat die Arbeit so oft zurückgeschickt, wie du erlaubst.",
    why_forge: "Es hat das für dich auf der Forge erledigt.",
    pr_failed: "Prüfungen fehlgeschlagen: {text}",
    pr_passed: "Prüfungen wieder grün: {text}",
    pr_conflict: "Hat einen Konflikt: {text}",
    pr_ready: "Bereit zum Mergen: {text}",
    pr_no_conflict: "Kein Konflikt, Prüfungen unbekannt: {text}",
    pr_closed: "Ohne Merge geschlossen: {text}",
    pr_gave_up: "{n}-mal repariert, schlägt weiter fehl: {text}",
    why_pr_gave_up: "codeg hat es so oft repariert, wie du erlaubst; jetzt bist du dran.",
    why_pr_merged: "Die Prüfungen waren grün, also hat codeg es zusammengeführt.",
    why_pr_cnb: "CNB zeigt keine Prüfungen; es wird zusammengeführt, sobald du zustimmst.",
    why_pr: "Es beobachtet diesen Pull Request für dich.",
    why_pr_ready: "Die Prüfungen sind grün und die Forge kann ihn mergen.",
    routine: "Bericht der Routine: {text}",
    routine_paused: "Routine pausiert: {text}",
    why_routine: "Eine Routine, die du eingerichtet hast, ist gelaufen.",
    why_routine_paused: "Sie ist dreimal hintereinander fehlgeschlagen oder der Agent, mit dem sie arbeitet, ist nicht mehr nutzbar; sie läuft erst wieder, wenn du nachsiehst.",    rule_failed: "Fehlgeschlagen, niemand kümmert sich: {text}",
    rule_review: "Wartet lange auf Prüfung: {text}",
    rule_pr_review: "Wartet auf dein Review: {text}",
    rule_uncommitted: "Nicht committete Änderungen: {text}",
    rule_idle: "Seit Längerem unverändert: {text}",
    rule_behind: "Hinter dem Zielbranch, mit Konflikten: {text}",
    why_proposal: "codeg hat es bemerkt; die Karte hat einen nächsten Schritt.",
    why_proposal_low: "codeg hat es bemerkt; nichts Dringendes.",
    brief: "Guten Morgen – {n} Dinge brauchen dich",
    brief_none: "Guten Morgen – dein Briefing ist fertig",
    wrap: "Tagesabschluss – morgen brauchen dich {n} Dinge",
    wrap_none: "Der Tagesabschluss ist fertig",
    why_brief: "Dein Morgen-Briefing.",
    why_wrap: "Dein üblicher Feierabend ist nah, oder du hast danach gefragt.",
    memory: "Gemerkt: {text}",
    memory_soul: "Persona",
    memory_rules: "Regeln",
    memory_user: "dein Profil",
    tidied: "Hat sein Gedächtnis aufgeräumt: {text}",
    tidied_draft: "Hat sein Gedächtnis aufgeräumt, als Entwurf für dich: {text}",
    skill_added: "Hat einen Ablauf festgehalten: {text}",
    skill_changed: "Hat seinen Ablauf-Skill geändert: {text}",
    skill_removed: "Hat seinen Ablauf-Skill entfernt: {text}",
    skill_draft: "Ein Ablauf-Skill zum Ansehen: {text}",
    check_true: "Geprüft: stimmt — {text}",
    check_false: "Geprüft: stimmt nicht — {text}",
    check_partly: "Geprüft: stimmt teilweise — {text}",
    check_unsure: "Geprüft: nicht feststellbar — {text}",
    check_unfinished: "Die Prüfung wurde nicht fertig: {text}",
    check_title: "Prüfen: {text}",
    why_memory: "Es hat sein Gedächtnis geändert; auf der Karte lässt sich das rückgängig machen.",
    plan_done: "Plan erledigt: {text}",
    plan_stuck: "Plan hängt fest: {text}",
    why_plan: "Es hat einen Plan, den es für dich aufgestellt hat, zu Ende gebracht.",
    why_plan_stuck: "Ein Schritt ist fehlgeschlagen und blieb es; was nicht davon abhängt, läuft weiter.",
};

const FR: Words = Words {
    primary: "Agent personnel",
    waiting: "Vous attend : {text}",
    approval: "Attend votre approbation : {text}",
    waited: "Vous attend depuis {n} min : {text}",
    session: "Une session vous attend depuis {n} min : {text}",
    done: "Terminé : {text}",
    failed: "Non terminé : {text}",
    review: "Prêt pour votre relecture : {text}",
    reply_empty: "Ouvrez codeg pour voir ce qu'il a fait",
    reminder: "Rappel : {text}",
    away: "Pendant votre absence : {n} éléments",
    batch: "{n} éléments pour vous",
    digest: "{n} nouveautés",
    more: "…et {n} de plus",
    assistants: "Vos assistants",
    hidden: "Ouvrez codeg pour le voir",
    why_reminder: "Vous avez demandé un rappel à {time}.",
    why_forwarded:
        "Le travail qu'il a confié pose une question à laquelle il n'a pas pu répondre pour vous.",
    why_approval: "Il ne peut pas continuer sans votre approbation.",
    why_question: "Il a besoin de votre réponse pour continuer.",
    why_confirm: "Vous avez demandé à confirmer ces actions d'abord.",
    why_stuck: "C'est à vous de décider de la suite.",
    why_waiting: "Personne n'a encore répondu.",
    why_done: "Il a confié ce travail pour vous.",
    why_reply: "Vous le lui avez demandé.",
    accepted: "Prêt à fusionner : {text}",
    accepted_pr: "Accepté : {text}",
    merged: "Fusionné : {text}",
    commented: "Commentaire publié : {text}",
    issue_closed: "Fermé : {text}",
    accept_ask: "À vous de décider de l'acceptation : {text}",
    used_up: "Toujours pas bon après les tours permis : {text}",
    accept_void: "Sa vérification ne vaut plus : {text}",
    why_acceptance: "Il a vérifié le travail qu'il a confié pour vous.",
    why_used_up: "Il l'a renvoyé autant de fois que vous le permettez.",
    why_forge: "Il l'a fait sur la forge pour vous.",
    pr_failed: "Vérifications en échec : {text}",
    pr_passed: "Vérifications de nouveau au vert : {text}",
    pr_conflict: "En conflit : {text}",
    pr_ready: "Prête à fusionner : {text}",
    pr_no_conflict: "Pas de conflit, vérifications inconnues : {text}",
    pr_closed: "Fermée sans fusion : {text}",
    pr_gave_up: "Corrigé {n} fois, échoue toujours : {text}",
    why_pr_gave_up: "codeg l'a corrigé autant de fois que tu le permets ; à toi maintenant.",
    why_pr_merged: "Ses vérifications étaient au vert, codeg l'a donc fusionné.",
    why_pr_cnb: "CNB n'affiche pas de vérifications ; il est fusionné dès que tu approuves.",
    why_pr: "Il surveille cette pull request pour vous.",
    why_pr_ready: "Ses vérifications sont au vert et la forge peut la fusionner.",
    routine: "Rapport de la routine : {text}",
    routine_paused: "Routine en pause : {text}",
    why_routine: "Une routine que vous avez configurée s'est exécutée.",
    why_routine_paused: "Elle a échoué trois fois de suite ou l'agent avec lequel elle travaille n'est plus utilisable ; elle ne s'exécutera plus tant que vous n'aurez pas regardé.",    rule_failed: "Échec, et personne ne s'en occupe : {text}",
    rule_review: "Attend une revue depuis longtemps : {text}",
    rule_pr_review: "Attend votre revue : {text}",
    rule_uncommitted: "Modifications non commitées : {text}",
    rule_idle: "Plus de mouvement depuis un moment : {text}",
    rule_behind: "En retard sur sa branche cible, avec des conflits : {text}",
    why_proposal: "codeg l'a remarqué ; la carte propose la suite.",
    why_proposal_low: "codeg l'a remarqué ; rien d'urgent.",
    brief: "Bonjour — {n} choses vous attendent",
    brief_none: "Bonjour — votre point du matin est prêt",
    wrap: "Bilan du jour — {n} choses vous attendent demain",
    wrap_none: "Le bilan du jour est prêt",
    why_brief: "Votre point du matin.",
    why_wrap: "Votre fin de journée habituelle approche, ou vous l'avez demandé.",
    memory: "Mémorisé : {text}",
    memory_soul: "personnalité",
    memory_rules: "règles",
    memory_user: "votre profil",
    tidied: "A rangé sa mémoire : {text}",
    tidied_draft: "A rangé sa mémoire, en brouillon pour vous : {text}",
    skill_added: "A consigné un processus : {text}",
    skill_changed: "A modifié sa compétence de processus : {text}",
    skill_removed: "A supprimé sa compétence de processus : {text}",
    skill_draft: "Une compétence de processus à examiner : {text}",
    check_true: "Vérifié : exact — {text}",
    check_false: "Vérifié : inexact — {text}",
    check_partly: "Vérifié : en partie exact — {text}",
    check_unsure: "Vérifié : impossible à dire — {text}",
    check_unfinished: "La vérification n’a pas abouti : {text}",
    check_title: "Vérifier : {text}",
    why_memory: "Il a modifié sa mémoire ; la carte permet d’annuler.",
    plan_done: "Plan terminé : {text}",
    plan_stuck: "Plan bloqué : {text}",
    why_plan: "Il a mené à bien un plan qu’il avait préparé pour vous.",
    why_plan_stuck: "Une étape a échoué et reste en échec ; ce qui n’en dépend pas continue.",
};

const PT: Words = Words {
    primary: "Agente pessoal",
    waiting: "Esperando por você: {text}",
    approval: "Esperando sua aprovação: {text}",
    waited: "Esperando por você há {n} min: {text}",
    session: "Uma sessão espera por você há {n} min: {text}",
    done: "Concluído: {text}",
    failed: "Não foi concluído: {text}",
    review: "Pronto para sua revisão: {text}",
    reply_empty: "Abra o codeg para ver o que ele fez",
    reminder: "Lembrete: {text}",
    away: "Enquanto você esteve fora: {n} itens",
    batch: "{n} itens para você",
    digest: "{n} novidades",
    more: "…e mais {n}",
    assistants: "Seus assistentes",
    hidden: "Abra o codeg para ver",
    why_reminder: "Você pediu um lembrete às {time}.",
    why_forwarded:
        "O trabalho que ele delegou está perguntando, e ele não pôde responder por você.",
    why_approval: "Ele só pode continuar com sua aprovação.",
    why_question: "Ele precisa da sua resposta para continuar.",
    why_confirm: "Você pediu para confirmar isso antes.",
    why_stuck: "Você precisa decidir o que vem a seguir.",
    why_waiting: "Ninguém respondeu ainda.",
    why_done: "Ele delegou este trabalho para você.",
    why_reply: "Você pediu isso a ele.",
    accepted: "Pronto para mesclar: {text}",
    accepted_pr: "Aceito: {text}",
    merged: "Mesclado: {text}",
    commented: "Comentado em {text}",
    issue_closed: "Fechado: {text}",
    accept_ask: "A decisão sobre a aceitação é sua: {text}",
    used_up: "Ainda não está certo após as rodadas permitidas: {text}",
    accept_void: "A verificação não vale mais: {text}",
    why_acceptance: "Ele verificou o trabalho que delegou por você.",
    why_used_up: "Ele devolveu o trabalho tantas vezes quanto você permite.",
    why_forge: "Ele fez isso na forja por você.",
    pr_failed: "Verificações falharam: {text}",
    pr_passed: "Verificações verdes de novo: {text}",
    pr_conflict: "Tem um conflito: {text}",
    pr_ready: "Pronto para mesclar: {text}",
    pr_no_conflict: "Sem conflito, verificações desconhecidas: {text}",
    pr_closed: "Fechado sem mesclar: {text}",
    pr_gave_up: "Corrigido {n} vezes e ainda falha: {text}",
    why_pr_gave_up: "O codeg corrigiu quantas vezes você permite; agora é com você.",
    why_pr_merged: "As verificações estavam verdes, então o codeg fez o merge.",
    why_pr_cnb: "O CNB não mostra verificações; o merge acontece quando você aprovar.",
    why_pr: "Ele acompanha este pull request para você.",
    why_pr_ready: "As verificações estão verdes e a forja pode mesclá-lo.",
    routine: "Relatório da rotina: {text}",
    routine_paused: "Rotina pausada: {text}",
    why_routine: "Uma rotina que você configurou foi executada.",
    why_routine_paused: "Falhou três vezes seguidas ou o agente com que trabalha não pode mais ser usado; não roda de novo até você olhar.",    rule_failed: "Falhou e ninguém está cuidando: {text}",
    rule_review: "Esperando revisão há muito tempo: {text}",
    rule_pr_review: "Esperando sua revisão: {text}",
    rule_uncommitted: "Alterações não commitadas: {text}",
    rule_idle: "Parado há um tempo: {text}",
    rule_behind: "Atrás do branch de destino, com conflitos: {text}",
    why_proposal: "O codeg percebeu; o cartão tem o próximo passo.",
    why_proposal_low: "O codeg percebeu; nada urgente.",
    brief: "Bom dia — {n} coisas precisam de você",
    brief_none: "Bom dia — seu resumo está pronto",
    wrap: "Fechamento do dia — {n} coisas precisam de você amanhã",
    wrap_none: "O fechamento do dia está pronto",
    why_brief: "Seu resumo da manhã.",
    why_wrap: "Seu horário habitual de encerrar está próximo, ou você pediu.",
    memory: "Memorizado: {text}",
    memory_soul: "persona",
    memory_rules: "regras",
    memory_user: "seu perfil",
    tidied: "Organizou a memória: {text}",
    tidied_draft: "Organizou a memória, como rascunho para você: {text}",
    skill_added: "Registrou um processo: {text}",
    skill_changed: "Alterou sua skill de processo: {text}",
    skill_removed: "Removeu sua skill de processo: {text}",
    skill_draft: "Uma skill de processo para você revisar: {text}",
    check_true: "Verificado: verdadeiro — {text}",
    check_false: "Verificado: não é verdade — {text}",
    check_partly: "Verificado: parcialmente verdadeiro — {text}",
    check_unsure: "Verificado: não dá para dizer — {text}",
    check_unfinished: "A verificação não terminou: {text}",
    check_title: "Verificar: {text}",
    why_memory: "Mudou o que lembra; o cartão permite desfazer.",
    plan_done: "Plano concluído: {text}",
    plan_stuck: "Plano travado: {text}",
    why_plan: "Concluiu um plano que preparou para você.",
    why_plan_stuck: "Uma etapa falhou e continuou falhando; o que não depende dela segue em frente.",
};

const AR: Words = Words {
    primary: "الوكيل الشخصي",
    waiting: "بانتظارك: {text}",
    approval: "بانتظار موافقتك: {text}",
    waited: "بانتظارك منذ {n} دقيقة: {text}",
    session: "جلسة بانتظارك منذ {n} دقيقة: {text}",
    done: "تم: {text}",
    failed: "لم يكتمل: {text}",
    review: "جاهز لمراجعتك: {text}",
    reply_empty: "افتح codeg لترى ما فعله",
    reminder: "تذكير: {text}",
    away: "أثناء غيابك: {n} أمور",
    batch: "{n} أمور لك",
    digest: "{n} تحديثات",
    more: "…و{n} أخرى",
    assistants: "مساعدوك",
    hidden: "افتح codeg لرؤيته",
    why_reminder: "طلبت تذكيرك في {time}.",
    why_forwarded: "العمل الذي أسنده يسأل، ولم يستطع الإجابة عنك.",
    why_approval: "لا يمكنه المتابعة حتى توافق.",
    why_question: "يحتاج إلى إجابتك ليتابع.",
    why_confirm: "طلبت تأكيد هذه الأمور أولاً.",
    why_stuck: "عليك أن تقرر ما سيحدث بعد ذلك.",
    why_waiting: "لم يردّ أحد بعد.",
    why_done: "هذا عمل أسنده نيابةً عنك.",
    why_reply: "أنت من طلب ذلك.",
    accepted: "جاهز للدمج: {text}",
    accepted_pr: "تم القبول: {text}",
    merged: "تم الدمج: {text}",
    commented: "تم التعليق على {text}",
    issue_closed: "تم الإغلاق: {text}",
    accept_ask: "القرار لك في القبول: {text}",
    used_up: "لم يصبح صحيحًا بعد الجولات المسموح بها: {text}",
    accept_void: "لم يعد فحصه ساريًا: {text}",
    why_acceptance: "فحص العمل الذي أسنده نيابةً عنك.",
    why_used_up: "أعاد العمل بعدد المرات التي تسمح بها.",
    why_forge: "قام بذلك على منصة الشيفرة نيابةً عنك.",
    pr_failed: "فشلت الفحوصات: {text}",
    pr_passed: "عادت الفحوصات إلى النجاح: {text}",
    pr_conflict: "يوجد تعارض: {text}",
    pr_ready: "جاهز للدمج: {text}",
    pr_no_conflict: "لا يوجد تعارض، وحالة الفحوصات غير معروفة: {text}",
    pr_closed: "أُغلق دون دمج: {text}",
    pr_gave_up: "أُصلح {n} مرات وما زال يفشل: {text}",
    why_pr_gave_up: "أصلحه codeg بقدر ما تسمح به؛ الأمر لك الآن.",
    why_pr_merged: "كانت فحوصه ناجحة، فدمجه codeg.",
    why_pr_cnb: "لا يعرض CNB أي فحوص؛ يُدمج بعد موافقتك.",
    why_pr: "هذا طلب سحب يراقبه نيابةً عنك.",
    why_pr_ready: "نجحت الفحوصات كلها والمنصة تستطيع دمجه.",
    routine: "تقرير الروتين: {text}",
    routine_paused: "تم إيقاف الروتين مؤقتًا: {text}",
    why_routine: "تم تشغيل روتين قمت بإعداده.",
    why_routine_paused: "فشل ثلاث مرات متتالية أو لم يعد من الممكن استخدام الوكيل الذي يعمل به؛ لن يعمل حتى تتحقق منه.",    rule_failed: "فشل ولا أحد يتابعه: {text}",
    rule_review: "ينتظر المراجعة منذ وقت طويل: {text}",
    rule_pr_review: "ينتظر مراجعتك: {text}",
    rule_uncommitted: "تغييرات غير مُودَعة: {text}",
    rule_idle: "لم يتحرك منذ مدة: {text}",
    rule_behind: "متأخر عن الفرع الهدف وبه تعارضات: {text}",
    why_proposal: "لاحظ codeg ذلك؛ في البطاقة الخطوة التالية.",
    why_proposal_low: "لاحظ codeg ذلك؛ ليس عاجلًا.",
    brief: "صباح الخير — {n} أمور تحتاجك",
    brief_none: "صباح الخير — موجز الصباح جاهز",
    wrap: "ختام اليوم — {n} أمور تحتاجك غدًا",
    wrap_none: "ختام اليوم جاهز",
    why_brief: "موجز صباحك.",
    why_wrap: "اقترب موعد انتهاء يومك المعتاد، أو طلبت ذلك.",
    memory: "تذكّرت: {text}",
    memory_soul: "الشخصية",
    memory_rules: "القواعد",
    memory_user: "ملفك الشخصي",
    tidied: "رتّب ذاكرته: {text}",
    tidied_draft: "رتّب ذاكرته، كمسودة لك: {text}",
    skill_added: "دوّن عملية: {text}",
    skill_changed: "غيّر مهارة العملية: {text}",
    skill_removed: "أزال مهارة العملية: {text}",
    skill_draft: "مهارة عملية بانتظار مراجعتك: {text}",
    check_true: "تم التحقق: صحيح — {text}",
    check_false: "تم التحقق: غير صحيح — {text}",
    check_partly: "تم التحقق: صحيح جزئيًا — {text}",
    check_unsure: "تم التحقق: لا يمكن الحكم — {text}",
    check_unfinished: "لم يكتمل التحقق: {text}",
    check_title: "تحقّق: {text}",
    why_memory: "غيّر ما يتذكره؛ يمكنك التراجع من البطاقة.",
    plan_done: "اكتملت الخطة: {text}",
    plan_stuck: "الخطة متوقفة: {text}",
    why_plan: "نفّذ خطة أعدّها لك حتى النهاية.",
    why_plan_stuck: "فشلت خطوة وبقيت فاشلة؛ ما لا يعتمد عليها يستمر.",
};

/// The title of a check codeg hands out for the owner (10.3), in their
/// language: what it checks, its first words.
pub fn check_title(locale: AppLocale, text: &str) -> String {
    fill(words(locale).check_title, &glimpse(text), 0, "")
}

fn words(locale: AppLocale) -> &'static Words {
    match locale {
        AppLocale::En => &EN,
        AppLocale::ZhCn => &ZH_CN,
        AppLocale::ZhTw => &ZH_TW,
        AppLocale::Ja => &JA,
        AppLocale::Ko => &KO,
        AppLocale::Es => &ES,
        AppLocale::De => &DE,
        AppLocale::Fr => &FR,
        AppLocale::Pt => &PT,
        AppLocale::Ar => &AR,
    }
}

fn fill(template: &str, text: &str, n: i64, time: &str) -> String {
    template
        .replace("{text}", text)
        .replace("{n}", &n.to_string())
        .replace("{time}", time)
}

/// The news's main line.
fn main_line(w: &Words, what: &What) -> String {
    match what {
        What::Reminder { text, .. } => fill(w.reminder, text, 0, ""),
        What::Waiting { text } => fill(w.waiting, text, 0, ""),
        What::Approval { text } => fill(w.approval, text, 0, ""),
        What::WaitedLong { text, minutes } => fill(w.waited, text, *minutes, ""),
        What::Session { text, minutes } => fill(w.session, text, *minutes, ""),
        What::Done { text } => fill(w.done, text, 0, ""),
        What::Failed { text } => fill(w.failed, text, 0, ""),
        What::Review { text } => fill(w.review, text, 0, ""),
        What::Accepted { text } => fill(w.accepted, text, 0, ""),
        What::AcceptedPr { text } => fill(w.accepted_pr, text, 0, ""),
        What::Merged { text } => fill(w.merged, text, 0, ""),
        What::Commented { text } => fill(w.commented, text, 0, ""),
        What::IssueClosed { text } => fill(w.issue_closed, text, 0, ""),
        What::AcceptAsk { text } => fill(w.accept_ask, text, 0, ""),
        What::UsedUp { text } => fill(w.used_up, text, 0, ""),
        What::AcceptVoid { text } => fill(w.accept_void, text, 0, ""),
        What::PrFailed { text } => fill(w.pr_failed, text, 0, ""),
        What::PrPassed { text } => fill(w.pr_passed, text, 0, ""),
        What::PrConflict { text } => fill(w.pr_conflict, text, 0, ""),
        What::PrReady { text } => fill(w.pr_ready, text, 0, ""),
        What::PrNoConflict { text } => fill(w.pr_no_conflict, text, 0, ""),
        What::PrClosed { text } => fill(w.pr_closed, text, 0, ""),
        What::PrGaveUp { text, rounds } => fill(w.pr_gave_up, text, *rounds as i64, ""),
        What::RoutineReport { title, text } => {
            let main = fill(w.routine, title, 0, "");
            match text {
                Some(t) => format!("{main}\n{t}"),
                None => main,
            }
        }
        What::RoutinePaused { text } => fill(w.routine_paused, text, 0, ""),
        What::Rule { rule, text } => {
            let t = match rule.as_str() {
                "failed" => w.rule_failed,
                "review" => w.rule_review,
                "pr_review" => w.rule_pr_review,
                "uncommitted" => w.rule_uncommitted,
                "idle" => w.rule_idle,
                "behind" => w.rule_behind,
                _ => "{text}",
            };
            fill(t, text, 0, "")
        }
        What::Brief { needs: 0 } => w.brief_none.to_string(),
        What::Brief { needs } => fill(w.brief, "", *needs as i64, ""),
        What::Wrap { needs: 0 } => w.wrap_none.to_string(),
        What::Wrap { needs } => fill(w.wrap, "", *needs as i64, ""),
        What::Memory {
            titles,
            soul,
            rules,
            user,
        } => {
            let mut parts = titles.clone();
            for (on, word) in [
                (*user, w.memory_user),
                (*soul, w.memory_soul),
                (*rules, w.memory_rules),
            ] {
                if on {
                    parts.push(word.to_string());
                }
            }
            if parts.is_empty() {
                parts.push("MEMORY.md".into());
            }
            fill(w.memory, &glimpse(&parts.join(", ")), 0, "")
        }
        What::Tidy {
            titles,
            soul,
            rules,
            user,
            draft,
        } => {
            let mut parts = titles.clone();
            for (on, word) in [
                (*user, w.memory_user),
                (*soul, w.memory_soul),
                (*rules, w.memory_rules),
            ] {
                if on {
                    parts.push(word.to_string());
                }
            }
            if parts.is_empty() {
                parts.push("MEMORY.md".into());
            }
            let line = if *draft { w.tidied_draft } else { w.tidied };
            fill(line, &glimpse(&parts.join(", ")), 0, "")
        }
        What::Skill {
            title,
            status,
            draft,
        } => {
            let line = match (status.as_str(), *draft) {
                (_, true) => w.skill_draft,
                ("added", _) => w.skill_added,
                ("deleted", _) => w.skill_removed,
                _ => w.skill_changed,
            };
            fill(line, &glimpse(title), 0, "")
        }
        What::Check { verdict, text } => {
            use crate::db::entities::personal_agent_check::FactVerdict;
            let line = match verdict {
                Some(FactVerdict::True) => w.check_true,
                Some(FactVerdict::False) => w.check_false,
                Some(FactVerdict::Partly) => w.check_partly,
                Some(FactVerdict::Unsure) => w.check_unsure,
                None => w.check_unfinished,
            };
            fill(line, &glimpse(text), 0, "")
        }
        What::PlanDone { text } => fill(w.plan_done, text, 0, ""),
        What::PlanStuck { text } => fill(w.plan_stuck, text, 0, ""),
        What::Reply { text } => text.clone().unwrap_or_else(|| w.reply_empty.to_string()),
        What::Plain { text } => text.clone(),
    }
}

/// Why it is told now: the body's last line.
fn reason(w: &Words, kind: &str, what: &What) -> Option<String> {
    let line = match kind {
        "reminder" => match what {
            What::Reminder { at, .. } => fill(w.why_reminder, "", 0, at),
            _ => return None,
        },
        "forwarded" => w.why_forwarded.into(),
        "approval" => w.why_approval.into(),
        "waiting" => w.why_waiting.into(),
        "question" => w.why_question.into(),
        "confirm" => w.why_confirm.into(),
        "stuck" => w.why_stuck.into(),
        "done" => w.why_done.into(),
        "reply" => w.why_reply.into(),
        "acceptance" => w.why_acceptance.into(),
        "used_up" => match what {
            What::PrGaveUp { .. } => w.why_pr_gave_up.into(),
            _ => w.why_used_up.into(),
        },
        "forge" => w.why_forge.into(),
        "pr" => w.why_pr.into(),
        "pr_ready" => match what {
            What::Merged { .. } => w.why_pr_merged.into(),
            What::PrNoConflict { .. } => w.why_pr_cnb.into(),
            _ => w.why_pr_ready.into(),
        },
        "routine" => w.why_routine.into(),
        "routine_paused" => w.why_routine_paused.into(),
        "proposal" => w.why_proposal.into(),
        "proposal_low" => w.why_proposal_low.into(),
        "brief" => match what {
            What::Wrap { .. } => w.why_wrap.into(),
            _ => w.why_brief.into(),
        },
        "memory" => w.why_memory.into(),
        "plan" => w.why_plan.into(),
        "plan_stuck" => w.why_plan_stuck.into(),
        _ => return None,
    };
    Some(line)
}

/// The body of one piece of news.
fn body_of(w: &Words, news: &News) -> String {
    let main = main_line(w, &news.what);
    match reason(w, news.kind, &news.what) {
        Some(r) => format!("{main}\n{r}"),
        None => main,
    }
}

/// What the primary is called in `locale` while the owner has not named
/// it (the menu bar's list, 10.10).
pub fn primary_name(locale: AppLocale) -> &'static str {
    words(locale).primary
}

/// The name a notification goes under.
fn title_of(w: &Words, row: &agent_entity::Model) -> String {
    let name = row.name.trim();
    if !name.is_empty() {
        return name.to_string();
    }
    match row.kind {
        BotKind::Primary => w.primary.to_string(),
        BotKind::Worker => format!("#{}", row.id),
    }
}

// ── the page's switches ─────────────────────────────────────────────────────

/// codeg's general notification switch and "hide contents", as the page
/// last synced them (the desktop posts under them).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Gate {
    pub enabled: bool,
    pub hide_body: bool,
}

impl Default for Gate {
    fn default() -> Self {
        Self {
            enabled: true,
            hide_body: false,
        }
    }
}

static GATE: RwLock<Option<Gate>> = RwLock::new(None);

/// The switches, read once from the database.
pub async fn gate(db: &sea_orm::DatabaseConnection) -> Gate {
    if let Some(g) = *GATE.read().unwrap_or_else(|e| e.into_inner()) {
        return g;
    }
    let g = crate::db::service::app_metadata_service::get_value(db, GATE_KEY)
        .await
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str::<Gate>(&s).ok())
        .unwrap_or_default();
    *GATE.write().unwrap_or_else(|e| e.into_inner()) = Some(g);
    g
}

/// The page's switches changed.
pub async fn set_gate(db: &sea_orm::DatabaseConnection, g: Gate) -> Result<(), String> {
    *GATE.write().unwrap_or_else(|e| e.into_inner()) = Some(g);
    let raw = serde_json::to_string(&g).map_err(|e| e.to_string())?;
    crate::db::service::app_metadata_service::upsert_value(db, GATE_KEY, &raw)
        .await
        .map_err(|e| e.to_string())
}

/// An assistant's face as a picture, for the notifications the desktop
/// posts (the page draws it).
pub fn avatar_png(data_dir: &std::path::Path, bot: i32) -> PathBuf {
    data_dir
        .join("personal-agent")
        .join("avatars")
        .join(format!("{bot}.png"))
}

/// The most a face picture may weigh.
pub const AVATAR_MAX_BYTES: usize = 256 * 1024;

// ── the state ───────────────────────────────────────────────────────────────

/// One thing waiting on the owner, as last seen.
#[derive(Debug, Clone)]
struct Need {
    since: DateTime<Utc>,
    text: String,
    told: bool,
}

#[derive(Debug, Clone)]
struct Held {
    news: News,
    level: Level,
    /// Ask the Dock / taskbar for the owner when it goes.
    attention: bool,
    /// Work that failed, told only if it is still news when it goes (B6).
    fail: Option<FailHold>,
}

/// One attempt of a piece of work that failed, as its news was held (B6):
/// for its assistant to pick it up first. It is still news unless that
/// attempt was taken over or went on meanwhile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FailHold {
    pub dispatch_id: i32,
    /// A board task's run that failed.
    pub task: Option<(i32, i32)>,
    /// The failure's result card.
    pub card_id: i32,
    /// The event that told the assistant: once the turn that took it is
    /// over, the hold is decided then.
    pub event_id: i32,
}

/// How soon a failure picked up again — not known to have gone out — is
/// asked about again (B6).
const FAIL_RECHECK_SECS: i64 = 30;

/// Held until a time — or until its turn is over, sooner (B6).
#[derive(Debug, Clone)]
struct Later {
    due: DateTime<Utc>,
    held: Held,
}

/// What reaching the owner remembers: the news told, what waits on them,
/// and what is held for later. In memory: a restart tells nothing twice
/// that was there before it (what waited then is taken as told).
pub struct Reach {
    inner: Mutex<State>,
}

struct State {
    started: DateTime<Utc>,
    told: HashSet<String>,
    order: VecDeque<String>,
    needs: HashMap<i32, HashMap<String, Need>>,
    focus: Vec<Held>,
    away: Vec<Held>,
    digest: Vec<Held>,
    /// Held until a time (B6).
    later: Vec<Later>,
    last_digest: DateTime<Utc>,
    #[cfg(test)]
    attending: Option<Attending>,
    #[cfg(test)]
    sent: Vec<Notify>,
}

impl Default for Reach {
    fn default() -> Self {
        Self::new(clock::now())
    }
}

impl Reach {
    pub fn new(started: DateTime<Utc>) -> Self {
        Self {
            inner: Mutex::new(State {
                started,
                told: HashSet::new(),
                order: VecDeque::new(),
                needs: HashMap::new(),
                focus: Vec::new(),
                away: Vec::new(),
                digest: Vec::new(),
                later: Vec::new(),
                last_digest: started,
                #[cfg(test)]
                attending: None,
                #[cfg(test)]
                sent: Vec::new(),
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The first time `key` is told: true.
    pub(super) fn claim(&self, key: &str) -> bool {
        let mut s = self.lock();
        if !s.told.insert(key.to_string()) {
            return false;
        }
        s.order.push_back(key.to_string());
        while s.order.len() > TOLD_MAX {
            if let Some(old) = s.order.pop_front() {
                s.told.remove(&old);
            }
        }
        true
    }

    /// Take what waits on assistant `bot` now: the news of what is new
    /// since codeg started.
    fn observe(&self, bot: i32, needs: &[NeedsYou]) -> Vec<News> {
        let mut s = self.lock();
        let started = s.started;
        let had = s.needs.remove(&bot).unwrap_or_default();
        let mut now_map: HashMap<String, Need> = HashMap::new();
        let mut out = Vec::new();
        for n in needs.iter().filter(|n| !n.mirror) {
            let key = need_key(bot, n);
            let told = match had.get(&key) {
                Some(seen) => seen.told,
                // Told as its own news when it was raised (7.5, 7.4).
                None if matches!(n.kind.as_str(), "acceptance" | "mergeable" | "routine_paused") => {
                    true
                }
                None => {
                    let news = news_of_need(bot, n, &key);
                    let fresh = n.since >= started;
                    if let (Some(news), true) = (news, fresh) {
                        out.push(news);
                        true
                    } else {
                        // Old (taken as told), or told only after waiting.
                        !fresh
                    }
                }
            };
            now_map.insert(
                key,
                Need {
                    since: n.since,
                    text: n.text.clone(),
                    told,
                },
            );
        }
        if !now_map.is_empty() {
            s.needs.insert(bot, now_map);
        }
        out
    }

    /// What has waited on the owner [`NUDGE_AFTER_MINS`] minutes without
    /// having been told.
    fn nudges(&self, now: DateTime<Utc>) -> Vec<News> {
        let mut s = self.lock();
        let mut out = Vec::new();
        for (bot, needs) in s.needs.iter_mut() {
            for (key, n) in needs.iter_mut() {
                let minutes = (now - n.since).num_minutes();
                if n.told || minutes < NUDGE_AFTER_MINS {
                    continue;
                }
                n.told = true;
                out.push(News {
                    key: format!("{key}:nudge"),
                    bot_id: *bot,
                    kind: "waiting",
                    what: What::WaitedLong {
                        text: n.text.clone(),
                        minutes,
                    },
                    link: Some(NotifyLink::Bot {
                        bot_id: *bot,
                        row_id: None,
                    }),
                    need: Some(key.clone()),
                });
            }
        }
        out
    }

    fn need_alive(&self, bot: i32, key: &str) -> bool {
        self.lock()
            .needs
            .get(&bot)
            .is_some_and(|m| m.contains_key(key))
    }

    fn hold(&self, route: Route, held: Held) {
        let mut s = self.lock();
        match route {
            Route::HoldFocus => s.focus.push(held),
            Route::HoldAway => s.away.push(held),
            Route::Digest => s.digest.push(held),
            _ => {}
        }
    }

    fn has_held(&self) -> bool {
        let s = self.lock();
        !(s.focus.is_empty() && s.away.is_empty() && s.digest.is_empty() && s.later.is_empty())
    }

    /// Hold `held` until `due` (B6).
    fn hold_until(&self, due: DateTime<Utc>, held: Held) {
        self.lock().later.push(Later { due, held });
    }

    /// The turn that took events `ids` is over: what was held for it is
    /// decided now, not at its time (B6).
    pub(super) fn decide_now(&self, ids: &[i32], now: DateTime<Utc>) {
        if ids.is_empty() {
            return;
        }
        for l in self.lock().later.iter_mut() {
            if l.held.fail.as_ref().is_some_and(|f| ids.contains(&f.event_id)) {
                l.due = l.due.min(now);
            }
        }
    }

    /// What was held until a time that has come.
    fn take_due(&self, now: DateTime<Utc>) -> Vec<Held> {
        let mut s = self.lock();
        let (due, wait): (Vec<Later>, Vec<Later>) =
            std::mem::take(&mut s.later).into_iter().partition(|l| l.due <= now);
        s.later = wait;
        due.into_iter().map(|l| l.held).collect()
    }

    #[cfg(test)]
    pub(super) fn later_count(&self) -> usize {
        self.lock().later.len()
    }

    #[cfg(test)]
    pub(super) fn set_attending(&self, att: Option<Attending>) {
        self.lock().attending = att;
    }

    #[cfg(test)]
    pub(super) fn take_sent(&self) -> Vec<Notify> {
        std::mem::take(&mut self.lock().sent)
    }

    #[cfg(test)]
    pub(super) fn held_counts(&self) -> (usize, usize, usize) {
        let s = self.lock();
        (s.focus.len(), s.away.len(), s.digest.len())
    }

    /// What reaching the owner goes by now (the rules ask too, 6.7).
    pub(super) fn attending_now(&self) -> Attending {
        self.attending()
    }

    fn attending(&self) -> Attending {
        #[cfg(test)]
        if let Some(a) = self.lock().attending.clone() {
            return a;
        }
        presence::now_attending()
    }
}

fn need_key(bot: i32, n: &NeedsYou) -> String {
    match (n.row_id, n.dispatch_id) {
        (Some(row), _) => format!("need:{bot}:{}:{row}", n.kind),
        (None, Some(d)) => format!("need:{bot}:{}:{d}:{}", n.kind, n.since.timestamp_millis()),
        (None, None) => format!("need:{bot}:{}:{}", n.kind, n.since.timestamp_millis()),
    }
}

/// The kind of news a need is (its level is the owner's for that kind):
/// dispatched work waiting in its own session is `waiting`.
pub fn need_kind(n: &NeedsYou) -> Option<&'static str> {
    Some(match n.kind.as_str() {
        "permission" => "approval",
        "plan" | "question" if n.forwarded => "forwarded",
        "plan" => "approval",
        "question" | "choice" => "question",
        "confirm" | "changed" => "confirm",
        "uncertain" | "loop" => "stuck",
        "input" => "waiting",
        // An acceptance card the owner is to answer (7.5).
        "acceptance" => "acceptance",
        // A watched pull request they can merge (7.4).
        "mergeable" => "pr_ready",
        // A routine codeg paused (6.9).
        "routine_paused" => "routine_paused",
        // A watched pull request codeg fixed as often as allowed (7.4).
        "pr_gave_up" => "used_up",
        // A plan stuck on a step (7.6).
        "plan_stuck" => "plan_stuck",
        _ => return None,
    })
}

/// The news a new need is told as at once; `None`: it is told only once it
/// has waited (dispatched work's own session said so already).
fn news_of_need(bot: i32, n: &NeedsYou, key: &str) -> Option<News> {
    let text = n.text.clone();
    // An acceptance card was told when it was raised (7.5).
    let kind = need_kind(n).filter(|k| {
        !matches!(
            *k,
            "waiting" | "acceptance" | "pr_ready" | "routine_paused" | "used_up" | "plan_stuck"
        )
    })?;
    let what = if kind == "approval" {
        What::Approval { text }
    } else {
        What::Waiting { text }
    };
    Some(News {
        key: key.to_string(),
        bot_id: bot,
        kind,
        what,
        link: Some(NotifyLink::Bot {
            bot_id: bot,
            row_id: n.row_id,
        }),
        need: Some(key.to_string()),
    })
}

/// What a decision is made with, read once.
struct Context {
    prefs: Prefs,
    quiet: bool,
    att: Attending,
    locale: AppLocale,
    primary: Option<i32>,
    gate: Gate,
}

// ── the host's side ─────────────────────────────────────────────────────────

impl EngineHost {
    async fn reach_context(&self, now: DateTime<Utc>) -> Context {
        let primary = svc::primary_bot(&self.db.conn).await.ok().flatten();
        let prefs = primary
            .as_ref()
            .map(|p| AccountView::from_settings(&p.settings).prefs)
            .unwrap_or_default();
        let tz = clock::zone_of(&prefs.time_zone);
        let hours = presence::hours(&self.db.conn, &prefs, now).await;
        let quiet = is_quiet(&prefs, &hours, tz, now);
        let locale = match primary.as_ref() {
            Some(p) => self.primary.owner_locale(p, None).await,
            None => AppLocale::En,
        };
        Context {
            quiet,
            att: self.reach.attending(),
            locale,
            primary: primary.map(|p| p.id),
            gate: gate(&self.db.conn).await,
            prefs,
        }
    }

    /// Tell the owner `news`, as their preferences and presence have it.
    pub async fn tell(&self, news: News) {
        self.tell_at(news, clock::now()).await
    }

    pub(super) async fn tell_at(&self, news: News, now: DateTime<Utc>) {
        if !self.reach.claim(&news.key) {
            return;
        }
        self.route_at(news, None, now).await
    }

    /// Tell the owner that work failed (B6) — not now: once its assistant
    /// has had `hold` to pick it up (sooner, when its turn on it is over),
    /// and only if it is still news then.
    pub async fn tell_failure(&self, news: News, fail: FailHold, due: DateTime<Utc>) {
        if !self.reach.claim(&news.key) {
            return;
        }
        self.reach.hold_until(
            due,
            Held {
                news,
                level: Level::Normal,
                attention: false,
                fail: Some(fail),
            },
        );
    }

    /// The turn that took events `ids` is over (B6).
    pub fn turn_over(&self, ids: &[i32]) {
        self.reach.decide_now(ids, clock::now());
    }

    /// Route news claimed already, as things are at `now`.
    async fn route_at(&self, news: News, fail: Option<FailHold>, now: DateTime<Utc>) {
        let Ok(Some(row)) = svc::get_bot(&self.db.conn, news.bot_id).await else {
            return;
        };
        let ctx = self.reach_context(now).await;
        let viewed = ctx.att.viewing.contains(&row.id);
        let route = decide(
            &ctx.prefs,
            news.kind,
            BotSwitches::of(&row),
            viewed,
            &ctx.att,
            ctx.quiet,
            now,
        );
        let level = ctx.prefs.level_of(news.kind);
        // What did not go out at once, counted for the weekly review (3.1):
        // news the owner silenced or is looking at is not held back.
        let held = match route {
            Route::Digest => Some("merged"),
            Route::HoldAway | Route::HoldFocus => Some("deferred"),
            Route::Drop if !viewed && !BotSwitches::of(&row).silent() && ctx.prefs.proactive() => {
                Some("kept")
            }
            _ => None,
        };
        if let Some(what) = held {
            let day = presence::hours_day(now, clock::zone_of(&ctx.prefs.time_zone));
            super::profile::count_held(&self.db, day, what).await;
        }
        match route {
            Route::Drop => {}
            Route::Now { in_page, attention } => {
                let n = self.single(&ctx, &row, &news, level, attention);
                self.send(&ctx, n, in_page).await;
            }
            hold => self.reach.hold(
                hold,
                Held {
                    news,
                    level,
                    attention: false,
                    fail,
                },
            ),
        }
    }

    /// The roster's live state of assistant `row` found `needs` waiting on
    /// the owner: tell what is new.
    pub async fn reach_needs(&self, row: &agent_entity::Model, needs: &[NeedsYou]) {
        for news in self.reach.observe(row.id, needs) {
            self.tell(news).await;
        }
    }

    /// Every [`super::live::BUSY_REPUSH`]: tell what has waited too long,
    /// and let go of what was held once its time has come.
    pub async fn reach_tick(&self) {
        self.reach_tick_at(clock::now()).await
    }

    pub(super) async fn reach_tick_at(&self, now: DateTime<Utc>) {
        for news in self.reach.nudges(now) {
            self.tell_at(news, now).await;
        }
        for news in self.session_nudges(now).await {
            self.tell_at(news, now).await;
        }
        if !self.reach.has_held() {
            return;
        }
        // Failures whose time came (B6): told now if still news, routed as
        // any news is.
        for h in self.reach.take_due(now) {
            if let Some(f) = h.fail.as_ref() {
                use super::dispatch::StillNews;
                match super::dispatch::failure_still_news(&self.db, f).await {
                    StillNews::Yes => {}
                    StillNews::No => continue,
                    // Picked up, not known to have gone out: asked again.
                    StillNews::NotYet => {
                        self.reach.hold_until(now + Duration::seconds(FAIL_RECHECK_SECS), h);
                        continue;
                    }
                }
            }
            self.route_at(h.news, h.fail, now).await;
        }
        let ctx = self.reach_context(now).await;
        // Everything held is decided anew, as things are now: the owner may
        // be back, typing, in their quiet hours, looking at the assistant,
        // or may have changed how news reaches them meanwhile. Low news is
        // looked at only when its digest is due.
        let (focus, away, digest) = {
            let mut s = self.reach.lock();
            let digest = if ctx.att.present
                && !ctx.quiet
                && !s.digest.is_empty()
                && now - s.last_digest >= Duration::hours(DIGEST_EVERY_HOURS)
            {
                s.last_digest = now;
                std::mem::take(&mut s.digest)
            } else {
                Vec::new()
            };
            (
                std::mem::take(&mut s.focus),
                std::mem::take(&mut s.away),
                digest,
            )
        };
        for (held, header) in [
            (focus, Header::Batch),
            (away, Header::Away),
            (digest, Header::Digest),
        ] {
            let mut on_page = Vec::new();
            let mut system = Vec::new();
            for (mut h, row) in self.still_to_tell(held).await {
                h.level = ctx.prefs.level_of(h.news.kind);
                let route = decide(
                    &ctx.prefs,
                    h.news.kind,
                    BotSwitches::of(&row),
                    ctx.att.viewing.contains(&row.id),
                    &ctx.att,
                    ctx.quiet,
                    now,
                );
                match route {
                    Route::Drop => {}
                    Route::Now { in_page, attention } => {
                        h.attention = attention;
                        if in_page {
                            on_page.push((h, row));
                        } else {
                            system.push((h, row));
                        }
                    }
                    // Low news waiting for its digest goes in it.
                    Route::Digest if header == Header::Digest => system.push((h, row)),
                    again => self.reach.hold(again, h),
                }
            }
            for (group, in_page) in [(on_page, true), (system, false)] {
                if let Some(n) = self.merged(&ctx, &group, header).await {
                    self.send(&ctx, n, in_page).await;
                }
            }
        }
    }

    /// Held news whose need (if it stood for one) is still there, with its
    /// assistant as it is now.
    async fn still_to_tell(&self, held: Vec<Held>) -> Vec<(Held, agent_entity::Model)> {
        let mut out = Vec::new();
        for h in held {
            if let Some(need) = &h.news.need {
                if !self.reach.need_alive(h.news.bot_id, need) {
                    continue;
                }
            }
            // A failure held on, its attempt taken over or gone on since (B6);
            // one picked up and not known to have gone out is held on.
            if let Some(f) = h.fail.as_ref() {
                use super::dispatch::StillNews;
                match super::dispatch::failure_still_news(&self.db, f).await {
                    StillNews::Yes => {}
                    StillNews::No => continue,
                    StillNews::NotYet => {
                        self.reach.hold_until(clock::now() + Duration::seconds(FAIL_RECHECK_SECS), h);
                        continue;
                    }
                }
            }
            let Ok(Some(row)) = svc::get_bot(&self.db.conn, h.news.bot_id).await else {
                continue;
            };
            out.push((h, row));
        }
        out
    }

    /// Sessions of codeg's that no assistant answers for, waiting on the
    /// owner [`NUDGE_AFTER_MINS`] minutes.
    #[cfg(test)]
    pub(super) async fn session_nudges_for_test(&self, now: DateTime<Utc>) -> Vec<News> {
        self.session_nudges(now).await
    }

    async fn session_nudges(&self, now: DateTime<Utc>) -> Vec<News> {
        // The rule's card (6.7) says it, with [Open the session], while the
        // rule is on.
        if let Ok(Some(p)) = svc::primary_bot(&self.db.conn).await {
            let prefs = AccountView::from_settings(&p.settings).prefs;
            if prefs.proactive() && prefs.rule_on("session") {
                return Vec::new();
            }
        }
        let glances = self.manager.session_glances().await;
        let mut out = Vec::new();
        let mut primary: Option<i32> = None;
        for g in glances {
            let Some(wait) = g.wait.as_ref() else {
                continue;
            };
            let minutes = (now - wait.since).num_minutes();
            if g.personal_agent || minutes < NUDGE_AFTER_MINS {
                continue;
            }
            let key = format!(
                "session:{}:{}",
                g.connection_id,
                wait.since.timestamp_millis()
            );
            if self.reach.lock().told.contains(&key) {
                continue;
            }
            // Work an assistant dispatched is that assistant's to tell
            // (its roster state has it): not looked at again.
            if self.live.task_conn_owner(&g.connection_id).is_some()
                || self.connection_engine(&g.connection_id).await
                || self.task_dispatch_of(&g.connection_id).await.is_some()
            {
                self.reach.claim(&key);
                continue;
            }
            if primary.is_none() {
                primary = svc::primary_bot(&self.db.conn)
                    .await
                    .ok()
                    .flatten()
                    .map(|p| p.id);
            }
            let Some(bot) = primary else {
                return out;
            };
            let title = match g.conversation_id {
                Some(cid) => {
                    crate::db::service::conversation_service::get_by_id(&self.db.conn, cid)
                        .await
                        .ok()
                        .and_then(|c| c.title)
                        .map(|t| glimpse(&t))
                        .filter(|t| !t.is_empty())
                }
                None => None,
            };
            out.push(News {
                key,
                bot_id: bot,
                kind: "waiting",
                what: What::Session {
                    text: title.unwrap_or_else(|| glimpse(&wait.text)),
                    minutes,
                },
                link: g.conversation_id.map(|cid| NotifyLink::Conversation {
                    conversation_id: cid,
                    folder_id: g.folder_id,
                }),
                need: None,
            });
        }
        out
    }

    fn single(
        &self,
        ctx: &Context,
        row: &agent_entity::Model,
        news: &News,
        level: Level,
        attention: bool,
    ) -> Notify {
        let w = words(ctx.locale);
        Notify {
            id: news.key.clone(),
            mode: Mode::System,
            level,
            bot_id: Some(row.id),
            title: title_of(w, row),
            body: body_of(w, news),
            hidden_body: w.hidden.to_string(),
            attention,
            in_page: false,
            link: news.link.clone(),
            avatar: serde_json::from_str::<Value>(&row.avatar).ok(),
        }
    }

    /// One notification for what was held; one piece of news is itself.
    async fn merged(
        &self,
        ctx: &Context,
        held: &[(Held, agent_entity::Model)],
        header: Header,
    ) -> Option<Notify> {
        let w = words(ctx.locale);
        match held {
            [] => None,
            [(h, row)] => Some(self.single(ctx, row, &h.news, h.level, h.attention)),
            many => {
                let one_bot = many.iter().all(|(_, r)| r.id == many[0].1.id);
                let n = many.len() as i64;
                let head = match header {
                    Header::Away => fill(w.away, "", n, ""),
                    Header::Batch => fill(w.batch, "", n, ""),
                    Header::Digest => fill(w.digest, "", n, ""),
                };
                let mut lines = vec![head];
                for (h, row) in many.iter().take(MERGED_LINES) {
                    let main = main_line(w, &h.news.what);
                    lines.push(if one_bot {
                        format!("· {main}")
                    } else {
                        format!("· {}: {main}", title_of(w, row))
                    });
                }
                if many.len() > MERGED_LINES {
                    lines.push(fill(w.more, "", (many.len() - MERGED_LINES) as i64, ""));
                }
                let level = many
                    .iter()
                    .map(|(h, _)| h.level)
                    .min_by_key(|l| match l {
                        Level::Urgent => 0,
                        Level::Normal => 1,
                        Level::Low => 2,
                    })
                    .unwrap_or(Level::Normal);
                let first = &many[0];
                let (title, bot_id, avatar, link) = if one_bot {
                    (
                        title_of(w, &first.1),
                        Some(first.1.id),
                        serde_json::from_str::<Value>(&first.1.avatar).ok(),
                        first.0.news.link.clone(),
                    )
                } else {
                    (
                        w.assistants.to_string(),
                        None,
                        None,
                        ctx.primary.map(|p| NotifyLink::Bot {
                            bot_id: p,
                            row_id: None,
                        }),
                    )
                };
                Some(Notify {
                    id: format!(
                        "merged:{}:{}",
                        header.as_str(),
                        many.iter()
                            .map(|(h, _)| h.news.key.as_str())
                            .collect::<Vec<_>>()
                            .join("|")
                    ),
                    mode: Mode::System,
                    level,
                    bot_id,
                    title,
                    body: lines.join("\n"),
                    hidden_body: w.hidden.to_string(),
                    attention: many.iter().any(|(h, _)| h.attention),
                    in_page: false,
                    link,
                    avatar,
                })
            }
        }
    }

    /// Deliver `n`: on the page while a window has the focus; else the
    /// desktop posts it, or the server's pages do.
    async fn send(&self, ctx: &Context, mut n: Notify, in_page: bool) {
        n.in_page = in_page;
        if in_page || ctx.att.window_focused {
            n.mode = Mode::Toast;
        } else {
            #[cfg(feature = "tauri-runtime")]
            if let crate::web::event_bridge::EventEmitter::Tauri(app) = &self.emitter {
                if !ctx.gate.enabled {
                    return;
                }
                let body = if ctx.gate.hide_body {
                    n.hidden_body.clone()
                } else {
                    n.body.clone()
                };
                let image = n
                    .bot_id
                    .map(|b| avatar_png(&self.data_dir, b))
                    .filter(|p| p.is_file());
                // Posting holds its thread until the OS confirms (up to 2 s on
                // macOS): nothing waits for it.
                let (app, title, attention) = (app.clone(), n.title.clone(), n.attention);
                tokio::spawn(async move {
                    if let Err(e) = crate::commands::notification::post_system_notification(
                        &app, title, body, image,
                    )
                    .await
                    {
                        tracing::warn!("[personal_agent] a notification was not posted: {e}");
                    }
                    if attention {
                        crate::commands::notification::request_attention(&app);
                    }
                });
                n.mode = Mode::Posted;
            }
            let _ = &ctx.gate;
        }
        #[cfg(test)]
        self.reach.lock().sent.push(n.clone());
        emit_event(&self.emitter, PERSONAL_AGENT_NOTIFY_EVENT, &n);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Header {
    Away,
    Batch,
    Digest,
}

impl Header {
    fn as_str(self) -> &'static str {
        match self {
            Header::Away => "away",
            Header::Batch => "batch",
            Header::Digest => "digest",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::personal_agent_prefs::OnOff;
    use crate::personal_agent::presence::DayHours;
    use chrono::TimeZone;

    fn learned(start: u32, end: u32) -> Hours {
        let d = DayHours {
            start,
            end,
            learned: true,
            days: 7,
            set: false,
        };
        Hours {
            workday: d,
            restday: d,
        }
    }

    fn at(h: u32, m: u32) -> DateTime<Utc> {
        // 2026-11-11 is a Wednesday; UTC as the zone.
        Utc.with_ymd_and_hms(2026, 11, 11, h, m, 0).unwrap()
    }

    fn here(typing: bool, now: DateTime<Utc>) -> Attending {
        Attending {
            present: true,
            last_typed: typing.then_some(now),
            window_focused: true,
            viewing: vec![],
            viewing_conversations: vec![],
        }
    }

    fn away() -> Attending {
        Attending::default()
    }

    const ON: BotSwitches = BotSwitches {
        hidden: false,
        muted: false,
        notify: true,
    };

    #[test]
    fn urgent_goes_at_once_normal_waits_for_the_owner() {
        let p = Prefs::default();
        let now = at(10, 0);
        let urgent = Route::Now {
            in_page: false,
            attention: true,
        };
        let normal_now = Route::Now {
            in_page: false,
            attention: false,
        };
        for att in [here(true, now), here(false, now), away()] {
            assert_eq!(decide(&p, "approval", ON, false, &att, false, now), urgent);
            assert_eq!(decide(&p, "reminder", ON, false, &att, false, now), urgent);
        }
        assert_eq!(
            decide(&p, "done", ON, false, &here(false, now), false, now),
            normal_now
        );
        assert_eq!(
            decide(&p, "done", ON, false, &here(true, now), false, now),
            Route::HoldFocus
        );
        assert_eq!(
            decide(&p, "done", ON, false, &away(), false, now),
            Route::HoldAway
        );
        assert_eq!(
            decide(&p, "exchange", ON, false, &here(false, now), false, now),
            Route::Drop
        );
        // "More": typing does not hold it; low news is merged.
        let more = Prefs {
            focus_wait: 0,
            low_via: LowVia::Digest,
            ..Prefs::default()
        };
        assert_eq!(
            decide(&more, "done", ON, false, &here(true, now), false, now),
            normal_now
        );
        assert_eq!(
            decide(&more, "exchange", ON, false, &away(), false, now),
            Route::Digest
        );
        // "Quiet": normal news only waits in "today"; urgent still goes.
        let quiet = Prefs {
            normal_via: NormalVia::Today,
            ..Prefs::default()
        };
        assert_eq!(
            decide(&quiet, "done", ON, false, &here(false, now), false, now),
            Route::Drop
        );
        assert_eq!(
            decide(&quiet, "forwarded", ON, false, &away(), false, now),
            urgent
        );
    }

    #[test]
    fn switches_looking_and_proactive_off_keep_it_quiet_but_reminders_go() {
        let p = Prefs::default();
        let now = at(10, 0);
        let att = here(false, now);
        for s in [
            BotSwitches { muted: true, ..ON },
            BotSwitches { hidden: true, ..ON },
            BotSwitches {
                notify: false,
                ..ON
            },
        ] {
            assert_eq!(
                decide(&p, "approval", s, false, &att, false, now),
                Route::Drop
            );
            assert!(matches!(
                decide(&p, "reminder", s, false, &att, false, now),
                Route::Now { .. }
            ));
        }
        assert_eq!(
            decide(&p, "approval", ON, true, &att, false, now),
            Route::Drop,
            "it is in front of them"
        );
        let off = Prefs {
            proactive: OnOff::Off,
            ..Prefs::default()
        };
        assert_eq!(
            decide(&off, "approval", ON, false, &att, false, now),
            Route::Drop
        );
        assert!(matches!(
            decide(&off, "reminder", ON, false, &att, false, now),
            Route::Now { .. }
        ));
        // A level the owner set.
        let low_done = Prefs {
            level_done: Level::Urgent,
            ..Prefs::default()
        };
        assert!(matches!(
            decide(&low_done, "done", ON, false, &away(), false, now),
            Route::Now {
                attention: true,
                ..
            }
        ));
        let in_page = Prefs {
            urgent_via: UrgentVia::InPage,
            ..Prefs::default()
        };
        assert_eq!(
            decide(&in_page, "approval", ON, false, &away(), false, now),
            Route::Now {
                in_page: true,
                attention: false
            }
        );
    }

    #[test]
    fn quiet_hours_let_only_reminders_through_unless_told_otherwise() {
        let p = Prefs::default();
        let now = at(23, 0);
        let att = here(false, now);
        assert!(matches!(
            decide(&p, "reminder", ON, false, &att, true, now),
            Route::Now { .. }
        ));
        assert_eq!(
            decide(&p, "approval", ON, false, &att, true, now),
            Route::HoldAway
        );
        assert_eq!(
            decide(&p, "done", ON, false, &att, true, now),
            Route::HoldAway
        );
        let lets = Prefs {
            quiet_lets: QuietLets::Urgent,
            low_via: LowVia::Digest,
            ..Prefs::default()
        };
        assert!(matches!(
            decide(&lets, "approval", ON, false, &att, true, now),
            Route::Now { .. }
        ));
        assert_eq!(
            decide(&lets, "done", ON, false, &att, true, now),
            Route::HoldAway
        );
        assert_eq!(
            decide(&lets, "exchange", ON, false, &att, true, now),
            Route::Drop
        );
    }

    #[test]
    fn quiet_is_outside_the_owners_hours() {
        let tz = Tz::UTC;
        let p = Prefs::default();
        let unlearned = Hours::default();
        assert!(is_quiet(&p, &unlearned, tz, at(22, 0)));
        assert!(is_quiet(&p, &unlearned, tz, at(7, 59)));
        assert!(!is_quiet(&p, &unlearned, tz, at(8, 0)));
        assert!(!is_quiet(&p, &unlearned, tz, at(21, 59)));
        let learned = learned(10 * 60 + 30, 25 * 60);
        assert!(is_quiet(&p, &learned, tz, at(10, 0)));
        assert!(!is_quiet(&p, &learned, tz, at(10, 30)));
        assert!(!is_quiet(&p, &learned, tz, at(23, 30)));
        // 00:30 on the 12th is the 11th's evening, till 01:00.
        let next = Utc.with_ymd_and_hms(2026, 11, 12, 0, 30, 0).unwrap();
        assert!(!is_quiet(&p, &learned, tz, next));
        assert!(is_quiet(&p, &learned, tz, next + Duration::minutes(30)));
        let fixed = Prefs {
            quiet_hours: QuietHours::Fixed,
            quiet_from: "21:00".into(),
            quiet_to: "07:00".into(),
            ..Prefs::default()
        };
        assert!(is_quiet(&fixed, &learned, tz, at(21, 0)));
        assert!(!is_quiet(&fixed, &learned, tz, at(7, 0)));
        let none = Prefs {
            quiet_hours: QuietHours::None,
            ..Prefs::default()
        };
        assert!(!is_quiet(&none, &unlearned, tz, at(3, 0)));
    }

    #[test]
    fn every_language_says_why_now() {
        for locale in [
            AppLocale::En,
            AppLocale::ZhCn,
            AppLocale::ZhTw,
            AppLocale::Ja,
            AppLocale::Ko,
            AppLocale::Es,
            AppLocale::De,
            AppLocale::Fr,
            AppLocale::Pt,
            AppLocale::Ar,
        ] {
            let w = words(locale);
            let news = News {
                key: "k".into(),
                bot_id: 1,
                kind: "reminder",
                what: What::Reminder {
                    text: "Stand-up".into(),
                    at: "15:00".into(),
                },
                link: None,
                need: None,
            };
            let body = body_of(w, &news);
            assert!(
                body.contains("Stand-up") && body.contains("15:00"),
                "{locale:?}: {body}"
            );
            assert!(fill(w.away, "", 3, "").contains('3'), "{locale:?}");
            assert!(fill(w.more, "", 2, "").contains('2'), "{locale:?}");
            // The morning brief and the wrap-up say how many (6.4, 6.5).
            for (what, n) in [
                (What::Brief { needs: 4 }, "4"),
                (What::Wrap { needs: 5 }, "5"),
            ] {
                assert!(main_line(w, &what).contains(n), "{locale:?}");
            }
            assert_ne!(
                main_line(w, &What::Brief { needs: 0 }),
                main_line(w, &What::Wrap { needs: 0 })
            );
            // A memory card names what it changed (7.7).
            let memory = main_line(
                w,
                &What::Memory {
                    titles: vec!["Release days".into()],
                    soul: true,
                    rules: false,
                    user: false,
                },
            );
            assert!(
                memory.contains("Release days") && memory.contains(w.memory_soul),
                "{locale:?}: {memory}"
            );
            assert!(w.memory.contains("{text}"), "{locale:?}");
            // A tidy-up and a process skill say theirs, a draft as one
            // (7.7, 7.8).
            let tidied = main_line(
                w,
                &What::Tidy {
                    titles: vec!["Home".into()],
                    soul: false,
                    rules: true,
                    user: false,
                    draft: false,
                },
            );
            assert!(
                tidied.contains("Home") && tidied.contains(w.memory_rules),
                "{locale:?}: {tidied}"
            );
            let draft = |status: &str, draft: bool| {
                main_line(
                    w,
                    &What::Skill {
                        title: "Release".into(),
                        status: status.into(),
                        draft,
                    },
                )
            };
            let lines = [
                draft("added", false),
                draft("modified", false),
                draft("deleted", false),
                draft("added", true),
            ];
            for l in &lines {
                assert!(l.contains("Release"), "{locale:?}: {l}");
            }
            let mut distinct = lines.to_vec();
            distinct.dedup();
            assert_eq!(distinct.len(), 4, "{locale:?}: {lines:?}");
            assert_ne!(
                tidied,
                main_line(
                    w,
                    &What::Tidy {
                        titles: vec!["Home".into()],
                        soul: false,
                        rules: true,
                        user: false,
                        draft: true,
                    },
                ),
                "{locale:?}"
            );
            // A check's verdicts (10.3): each its own line, with what it checked.
            {
                use crate::db::entities::personal_agent_check::FactVerdict;
                let checked: Vec<String> = [
                    Some(FactVerdict::True),
                    Some(FactVerdict::False),
                    Some(FactVerdict::Partly),
                    Some(FactVerdict::Unsure),
                    None,
                ]
                .into_iter()
                .map(|verdict| {
                    main_line(
                        w,
                        &What::Check {
                            verdict,
                            text: "The build passes.\nMore.".into(),
                        },
                    )
                })
                .collect();
                for l in &checked {
                    assert!(
                        l.contains("The build passes.") && !l.contains("More."),
                        "{locale:?}: {l}"
                    );
                }
                let mut distinct = checked.clone();
                distinct.sort();
                distinct.dedup();
                assert_eq!(distinct.len(), 5, "{locale:?}: {checked:?}");
                assert!(w.check_title.contains("{text}"), "{locale:?}");
            }
            for t in [
                w.waiting, w.approval, w.waited, w.session, w.done, w.failed, w.review, w.reminder,
            ] {
                assert!(t.contains("{text}"), "{locale:?}: {t}");
            }
            for (kind, _, _) in NEWS {
                if !matches!(*kind, "exchange" | "changed" | "answered" | "reminder") {
                    assert!(
                        reason(
                            w,
                            kind,
                            &What::Plain {
                                text: String::new()
                            }
                        )
                        .is_some(),
                        "{locale:?} {kind}"
                    );
                }
            }
        }
    }

    fn need(
        kind: &str,
        row: Option<i32>,
        dispatch: Option<i32>,
        since: DateTime<Utc>,
        forwarded: bool,
    ) -> NeedsYou {
        NeedsYou {
            kind: kind.into(),
            text: "Keep the shim?".into(),
            since,
            row_id: row,
            count: 1,
            mirror: false,
            dispatch_id: dispatch,
            forwarded,
        }
    }

    #[test]
    fn a_need_is_told_once_as_it_comes_and_waiting_work_after_ten_minutes() {
        let r = Reach::new(at(9, 0));
        let before = need("permission", Some(1), None, at(8, 0), false);
        let approval = need("permission", Some(2), None, at(9, 5), false);
        let forwarded = need("question", Some(3), None, at(9, 5), true);
        let own = need("question", Some(4), None, at(9, 5), false);
        let card = need("loop", Some(5), None, at(9, 5), false);
        let input = need("input", None, Some(7), at(9, 5), false);
        let mirror = NeedsYou {
            mirror: true,
            ..need("permission", Some(6), None, at(9, 5), false)
        };
        let all = vec![
            before,
            approval,
            forwarded,
            own,
            card,
            input.clone(),
            mirror,
        ];
        let told: Vec<&str> = r.observe(5, &all).iter().map(|n| n.kind).collect();
        assert_eq!(
            told,
            vec!["approval", "forwarded", "question", "stuck"],
            "what came before codeg started was told then; a mirror is its source's; \
             waiting work is told only after a while"
        );
        assert!(r.observe(5, &all).is_empty(), "once");
        assert!(r.nudges(at(9, 14)).is_empty());
        let nudged = r.nudges(at(9, 16));
        assert_eq!(nudged.len(), 1);
        assert_eq!(nudged[0].kind, "waiting");
        assert_eq!(
            nudged[0].what,
            What::WaitedLong {
                text: "Keep the shim?".into(),
                minutes: 11
            }
        );
        assert!(r.nudges(at(9, 40)).is_empty(), "once");
        let key = need_key(5, &input);
        assert!(r.need_alive(5, &key));
        r.observe(5, &[]);
        assert!(!r.need_alive(5, &key), "gone is forgotten");
    }

    #[test]
    fn a_glimpse_is_the_first_words() {
        assert_eq!(
            glimpse("\n## **Fixed** the `login`\nmore"),
            "Fixed the login"
        );
        assert_eq!(reply_glimpse("```json-render\n{}\n```"), None);
        assert_eq!(
            reply_glimpse("Done — see #12."),
            Some("Done — see #12.".into())
        );
        let long = "x".repeat(300);
        assert_eq!(glimpse(&long).chars().count(), TEXT_CHARS + 1);
    }
}
