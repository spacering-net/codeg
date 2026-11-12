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
    if quiet {
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
};

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
        "used_up" => w.why_used_up.into(),
        "forge" => w.why_forge.into(),
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
    fn claim(&self, key: &str) -> bool {
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
                // Told as its own news when it was raised (7.5).
                None if n.kind == "acceptance" => true,
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
        !(s.focus.is_empty() && s.away.is_empty() && s.digest.is_empty())
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
        _ => return None,
    })
}

/// The news a new need is told as at once; `None`: it is told only once it
/// has waited (dispatched work's own session said so already).
fn news_of_need(bot: i32, n: &NeedsYou, key: &str) -> Option<News> {
    let text = n.text.clone();
    // An acceptance card was told when it was raised (7.5).
    let kind = need_kind(n).filter(|k| !matches!(*k, "waiting" | "acceptance"))?;
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
            let Ok(Some(row)) = svc::get_bot(&self.db.conn, h.news.bot_id).await else {
                continue;
            };
            out.push((h, row));
        }
        out
    }

    /// Sessions of codeg's that no assistant answers for, waiting on the
    /// owner [`NUDGE_AFTER_MINS`] minutes.
    async fn session_nudges(&self, now: DateTime<Utc>) -> Vec<News> {
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
