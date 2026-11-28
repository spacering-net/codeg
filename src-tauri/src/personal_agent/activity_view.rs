//! The activity tab's one list (C1): what "today" has, an assistant's open
//! matters and its routines, put by whose turn it is — the owner's (waits
//! on them, with the assistants' suggestions as one line), an agent's
//! (under way, each with what stops it), something outside's (watched:
//! checks, a review, a message in a queue — codeg goes on with it on its
//! own), the clock's (coming up), nobody's (done today) — each thing once.
//! The command reads what goes in from one snapshot of the database; this
//! puts it together.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use serde::Serialize;

use super::routines::RoutineView;
use super::today::{TodayRow, TodayView};
use crate::db::entities::personal_agent_dispatch::DispatchState;
use crate::db::entities::personal_agent_item::{ItemKind, WaitsFor};
use crate::models::personal_agent::{DispatchInfo, ItemInfo};

/// "Today"'s rows that are something else happening on a piece of work, not
/// the work: they stand for no matter — but a watched pull request's row,
/// which stands for the work delivered to it ([`stands_for`]).
const STANDS_FOR_NOTHING: [&str; 7] = [
    "answered",
    "pr",
    "pr_merged",
    "pr_gone",
    "routine",
    "routine_run",
    "routine_report",
];

/// What the new list can do, for a page to tell (11): which groups it has,
/// and — from later steps — which actions.
const CAPABILITIES: [&str; 7] = [
    "groups_v2",
    // The row's own actions (6.5).
    "work_retry",
    "pr_merge",
    "message_nudge",
    "rehand",
    // What a row waiting on the owner asks, answered on it (7.5).
    "ask_inline",
    // A watched pull request read or not, waiting long (6.6).
    "watch_health",
];

/// The card the latest firing of a matter raised, as it stands (C1).
#[derive(Debug, Clone, Copy)]
pub struct ItemCard {
    pub row_id: i32,
    /// Its notice: what the panel's [Hand to ...] answers.
    pub notice_id: i32,
    /// Open, its notice open: the owner's to act on.
    pub open: bool,
    /// Handed to its assistant.
    pub handed: bool,
    /// Come due for its assistant to do (`at_due = act`): woken to it.
    pub woke: bool,
    /// The owner's message that handed it over (`hand_row_id`, M0-4); an
    /// older card does not say.
    pub hand_row: Option<i32>,
}

/// A message an assistant sent another and waits for an answer to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SentMessage {
    pub id: i32,
    /// The thread it is on.
    pub thread: Option<i32>,
    /// The assistant it was sent to.
    pub to_bot: i32,
}

/// Where a piece of work came from: who handed it out, the input it was
/// made for (`message:<id>`, ...) and the thread between assistants it is
/// on.
#[derive(Debug, Clone, Default)]
pub struct WorkSource {
    pub bot: Option<i32>,
    pub for_input: Option<String>,
    pub thread: Option<i32>,
}

impl WorkSource {
    /// Whether it is its assistant's work made for message `m`.
    fn made_for(&self, m: &SentMessage) -> bool {
        self.bot == Some(m.to_bot)
            && self.for_input.as_deref() == Some(format!("message:{}", m.id).as_str())
    }

    /// Whether it is its assistant's work on `m`'s thread — made for another
    /// input on it (a later message of the same talk).
    fn on_thread_of(&self, m: &SentMessage) -> bool {
        self.bot == Some(m.to_bot) && m.thread.is_some() && self.thread == m.thread
    }
}

/// Where an input an assistant is to take up — a message to it, a reminder
/// handed to it or come due for it, the owner's answer, a routine's run,
/// news of work that just failed — stands, as the database says (6.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Standing {
    /// Waiting for `bot`'s next turn: it takes it up on its own.
    Queued { bot: i32 },
    /// Taken up once and waiting for `bot`'s turn again (a turn cut off,
    /// its input put back): it is no longer to be taken back.
    Requeued { bot: i32 },
    /// In `bot`'s turn now — batch `batch`: stopping that turn stops it.
    InTurn { bot: i32, batch: i32 },
    /// Its turn is over, and nobody takes it up again on their own.
    Ended,
}

/// A watched pull request, as the list needs it (6.2).
#[derive(Debug, Clone)]
pub struct WatchFacts {
    pub pr: RowPr,
    /// The work it was delivered from: the dispatch, its board task.
    pub dispatch_id: Option<i32>,
    pub task_id: Option<i32>,
    /// When it began to be watched (the delivery): a run of the task begun
    /// after it is a later one's.
    pub since: DateTime<Utc>,
    /// Its rung (`checks_failed`, `conflict`, `waiting_checks`, `open`, ...).
    pub phase: Option<String>,
    /// A round fixing it, under way: that work.
    pub fixing: Option<i32>,
    /// Failed or in conflict a moment ago, and codeg fixes it on its own:
    /// about to be fixed.
    pub fix_pending: bool,
    /// How its watch stands beyond its rung (6.6): read or not, waiting
    /// long, for a review.
    pub health: WatchHealth,
}

/// How a watched pull request's watch stands beyond its rung (6.6), as
/// read against the owner's thresholds.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum WatchHealth {
    #[default]
    Fine,
    /// It cannot be read (`kind`: `auth`, `no_account`, `config` at once;
    /// `network`, `api`, `timeout` once its last good read is older than
    /// the checks' threshold): the owner's to see to.
    ReadFailed(String),
    /// Its checks have run this many hours (past the threshold) with no
    /// result.
    ChecksSlow(u32),
    /// Green and blocked by a review it waits on.
    ReviewPending,
    /// ... waited on this many days (past the threshold).
    ReviewSlow(u32),
}

/// What the database says beyond "today" (6.2): where each input stands,
/// each watched pull request.
#[derive(Debug, Clone, Default)]
pub struct Facts {
    /// Each `message` matter's message, at its receiver.
    pub messages: HashMap<i32, Standing>,
    /// Each matter whose input an assistant takes up: a reminder handed to
    /// it or come due for it, a follow-up come due, the owner's answer.
    pub inputs: HashMap<i32, Standing>,
    /// Each routine run with no work of its own, by run.
    pub routine_runs: HashMap<i32, Standing>,
    /// Each piece of work that just failed, its assistant's to pick up
    /// first (B6): the news of it, by work.
    pub looking: HashMap<i32, Standing>,
    /// Each watched pull request, by watch.
    pub watches: HashMap<i32, WatchFacts>,
    /// Failed work whose failure the owner saw to already (6.5): handed to
    /// its assistant, or being seen to — its assistant's now, not theirs.
    pub handed: HashSet<i32>,
}

/// What the list is made of, read from one snapshot.
pub struct Inputs {
    /// The page's assistant (the primary's real id on its page).
    pub bot: i32,
    pub primary: bool,
    pub today: TodayView,
    /// Its open matters, none another's work took over.
    pub items: Vec<ItemInfo>,
    /// The assistant of each matter.
    pub item_bots: HashMap<i32, i32>,
    /// The board task of each matter's dispatch.
    pub item_tasks: HashMap<i32, i32>,
    /// The card of each matter's latest firing, still waiting on it.
    pub item_cards: HashMap<i32, ItemCard>,
    /// The message each `message` matter waits for an answer to, its
    /// assistant the sender.
    pub item_messages: HashMap<i32, SentMessage>,
    /// Where each piece of work the rows point at came from.
    pub works: HashMap<i32, WorkSource>,
    pub facts: Facts,
    /// The handed-out work that can be stopped now (queued, running, waiting
    /// for input): what a row under way is stopped by must be among it.
    pub live_work: HashSet<i32>,
    pub routines: Vec<RoutineView>,
    /// The rows waiting on the owner they ignored ([`dismiss_mark`]): left
    /// out, and not counted.
    pub dismissed: HashSet<String>,
    pub as_of: DateTime<Utc>,
}

/// Why a row is in its group, for its chip (5.2): what it waits on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RowWhy {
    /// The message's receiver took it up and ended its turn without an
    /// answer: nobody asks again.
    NoReply { peer: i32 },
    /// Handed to its assistant, whose turn on it is over with the matter
    /// still open.
    Unfinished,
    /// A pull request's checks failed (`checks`) or it is in conflict
    /// (`conflict`), and nobody fixes it.
    NobodyFixing { cause: &'static str },
    /// ... codeg is about to fix it.
    FixPending,
    /// ... a round fixing it is under way (the row is that work's).
    Fixing,
    /// Its checks passed and the platform does not let it be merged yet.
    PlatformBlocked,
    /// Queued to merge.
    MergeQueued,
    /// Merging on this machine.
    Merging,
    /// Being checked, its check not sent yet.
    CheckPreparing,
    /// Being checked, its check over: its verdict being taken in.
    CheckSettling,
    /// Waiting for `bot`'s next turn.
    Queued { bot: i32 },
    /// Taken up once, waiting for `bot`'s turn again: no longer to be
    /// taken back.
    Redelivering { bot: i32 },
    /// In `bot`'s turn now.
    InTurn { bot: i32 },
    /// Just failed: `bot`, its assistant, is to pick it up first.
    Looking { bot: i32 },
    /// A follow-up with no time and nothing to bring it up.
    NoTrigger,
    /// Handed-out work that failed, no "today" row of it left.
    Failed,
    /// A watched pull request codeg cannot read (`error`: the kind, 6.6).
    ReadFailed { error: String },
    /// Its checks have run `hours` with no result.
    ChecksSlow { hours: u32 },
    /// Green, and blocked by a review it waits on.
    ReviewPending,
    /// ... waited on `days`.
    ReviewSlow { days: u32 },
}

/// What [Stop] on a row under way stops (5.2) — every such row has one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RowStop {
    /// A piece of handed-out work (`personal_agent_dispatch_stop`, the
    /// version from the view's `dispatches`).
    Dispatch { id: i32 },
    /// A board task no assistant handed out: the board's cancel — of run
    /// `run_seq`, the one the row read (one run again since is not
    /// stopped).
    Task { id: i32, run_seq: Option<i32> },
    /// An assistant's turn, batch `batch` (`personal_agent_cancel_turn`):
    /// that turn only — another begun since is not stopped.
    Turn { bot: i32, batch: i32 },
}

/// A card a row is, as its buttons answer it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RowNotice {
    pub id: i32,
    /// What it asks (`acceptance`, `confirm`, `mergeable`, ...).
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    /// An acceptance's: it says what sending the work back would.
    pub has_message: bool,
}

/// A watched pull request a row is of.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RowPr {
    pub watch_id: i32,
    pub number: i64,
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_sha: Option<String>,
    /// A GitLab merge request.
    pub is_mr: bool,
}

/// What a row waiting on the owner asks, as it is answered on the row
/// itself (7.5): through the assistant whose request it is, through the
/// ask card an executor's request was forwarded on (what records the
/// owner's answer as theirs, on the page), or on the session's own
/// connection.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RowAsk {
    Permission {
        via: AskVia,
        #[serde(skip_serializing_if = "Option::is_none")]
        connection_id: Option<String>,
        request_id: String,
        tool_call: serde_json::Value,
        options: Vec<crate::acp::types::PermissionOptionInfo>,
        /// Requests waiting behind it.
        #[serde(skip_serializing_if = "Option::is_none")]
        queued: Option<u32>,
    },
    Question {
        via: AskVia,
        #[serde(skip_serializing_if = "Option::is_none")]
        connection_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        ask_id: Option<i32>,
        question_id: String,
        questions: serde_json::Value,
    },
    Plan {
        via: AskVia,
        #[serde(skip_serializing_if = "Option::is_none")]
        connection_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        ask_id: Option<i32>,
        approval_id: String,
        plan: String,
    },
    /// A choice card of one question, its options plain.
    Choice {
        notice_id: i32,
        options: Vec<ChoiceOption>,
    },
}

/// Whose commands answer a [`RowAsk`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AskVia {
    /// The assistant's own request: `personal_agent_*`, with its bot.
    Assistant,
    /// A session's: `acp_*` on its connection.
    Session,
    /// An executor's, forwarded to the owner: `personal_agent_ask_answer`.
    Ask,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChoiceOption {
    pub key: String,
    pub label: String,
}

/// The routine run a row of work came from (5.3): its run, kept as the
/// work's, not a row of its own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RunRef {
    pub run_id: i32,
    pub routine_id: i32,
    pub title: String,
}

/// One thing in the list: "today"'s row of it, the matter it stands for,
/// or a routine.
#[derive(Debug, Clone, Serialize)]
pub struct ActivityRow {
    /// The row's own key, unique in the list.
    pub key: String,
    /// The assistant it is of — what its actions go to (another's, on the
    /// primary's page); `None`, the owner's own.
    pub bot_id: Option<i32>,
    /// The thing it is, kept across groups and reads (its matter's or its
    /// work's when it has one): what its unfolding is kept by.
    pub thing: String,
    pub today: Option<TodayRow>,
    pub item: Option<ItemInfo>,
    pub routine: Option<RoutineView>,
    /// The card of a matter's latest firing that has no "today" row (one
    /// from another day): "view the reminder".
    pub card_row_id: Option<i32>,
    /// The matter's reminder card while it is open, the owner's to answer:
    /// what the panel's [Hand to ...] answers.
    pub card_notice_id: Option<i32>,
    /// ... handed to its assistant: what [Hand it again] answers (6.5).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hand_notice_id: Option<i32>,
    /// Rows of the same chain this one stands for: a message its assistant
    /// waits on an answer to while the receiver does this work for it.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub folded: Vec<ActivityRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub why: Option<RowWhy>,
    /// Under way: what stops it (every row under way has one).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop: Option<RowStop>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notice: Option<RowNotice>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr: Option<RowPr>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run: Option<RunRef>,
    /// A board task's row: the task as it read it — what an act on it from
    /// the row holds to (6.5).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<RowTask>,
    /// What it asks, answered on it (7.5).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ask: Option<RowAsk>,
    /// A row waiting on the owner: what [Ignore] on it sends back — the row
    /// as it stands now ([`dismiss_mark`]). Ignored, it is out of the list
    /// until something moves it on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dismiss: Option<String>,
}

/// What ignoring a row waiting on the owner holds to: the thing it is, and
/// when it last moved — the same thing moving on (stuck again, failed
/// again, a new question) shows again. A reminder is held to its matter as
/// it last changed: the same matter is "today"'s `reminder:` row on the day
/// it came due and the matter's own row once that day is over.
///
/// Any other row is held to what it waits on too ([`why_mark`]): a watched
/// pull request's row moves only when a read finds a change, so one ignored
/// while its checks ran long would otherwise stay out of sight once it
/// cannot be read at all. A matter's own marks need it not — what it waits on
/// changes with the matter — and must not take it: its reminder's row and its
/// own are one mark.
pub fn dismiss_mark(row: &ActivityRow) -> String {
    let at = match (&row.item, &row.today) {
        (Some(i), None) => i.updated_at,
        (Some(i), Some(t)) if t.kind == "reminder" => i.updated_at,
        _ => {
            let at = moved(row).timestamp_millis();
            return match row.why.as_ref() {
                Some(why) => format!("{}@{at}#{}", row.thing, why_mark(why)),
                None => format!("{}@{at}", row.thing),
            };
        }
    };
    format!("{}@{}", row.thing, at.timestamp_millis())
}

/// What a row waits on, as an ignore mark holds to it: the kind, and what
/// tells one such wait from another (a read failing on its token vs on the
/// network, a conflict vs failed checks). Not the hours or days a wait has
/// run — that grows on its own, and an ignored row would show every hour.
fn why_mark(why: &RowWhy) -> String {
    match why {
        RowWhy::NoReply { peer } => format!("no_reply:{peer}"),
        RowWhy::Unfinished => "unfinished".into(),
        RowWhy::NobodyFixing { cause } => format!("nobody_fixing:{cause}"),
        RowWhy::FixPending => "fix_pending".into(),
        RowWhy::Fixing => "fixing".into(),
        RowWhy::PlatformBlocked => "platform_blocked".into(),
        RowWhy::MergeQueued => "merge_queued".into(),
        RowWhy::Merging => "merging".into(),
        RowWhy::CheckPreparing => "check_preparing".into(),
        RowWhy::CheckSettling => "check_settling".into(),
        RowWhy::Queued { bot } => format!("queued:{bot}"),
        RowWhy::Redelivering { bot } => format!("redelivering:{bot}"),
        RowWhy::InTurn { bot } => format!("in_turn:{bot}"),
        RowWhy::Looking { bot } => format!("looking:{bot}"),
        RowWhy::NoTrigger => "no_trigger".into(),
        RowWhy::Failed => "failed".into(),
        RowWhy::ReadFailed { error } => format!("read_failed:{error}"),
        RowWhy::ChecksSlow { .. } => "checks_slow".into(),
        RowWhy::ReviewPending => "review_pending".into(),
        RowWhy::ReviewSlow { .. } => "review_slow".into(),
    }
}

/// A board task as a row read it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RowTask {
    pub id: i32,
    pub run_seq: i32,
    pub updated_at: DateTime<Utc>,
    /// The assistant's work it is of; `None`, the owner's own.
    pub dispatch_id: Option<i32>,
}

/// The primary's pill (C6): what waits on the owner, and the first of them
/// in the list.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Pill {
    pub count: usize,
    pub first: Option<String>,
}

/// The five groups (5.1), by whose turn it is.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ActivityGroups {
    /// The owner's: nobody else moves it on.
    pub needs: Vec<ActivityRow>,
    /// The assistants' suggestions: the owner's too, one line, not counted.
    pub suggestions: Vec<ActivityRow>,
    /// An agent's, at it now: each has what stops it.
    pub running: Vec<ActivityRow>,
    /// Something outside's, codeg going on with it on its own.
    pub watch: Vec<ActivityRow>,
    /// The clock's.
    pub next: Vec<ActivityRow>,
    pub done: Vec<ActivityRow>,
    /// What waits on the owner: `needs`, counted once everything is in its
    /// place — no suggestion among it.
    pub waiting: usize,
    pub pill: Pill,
}

#[derive(Debug, Clone, Serialize)]
pub struct ActivityView {
    /// The groups (5.1). A page that knows them reads them alone.
    pub groups: ActivityGroups,
    /// What this list can do ([`CAPABILITIES`]).
    pub capabilities: Vec<&'static str>,
    // An older page's four groups, as it reads them (11): what waits on
    // the owner with the suggestions; what is under way with what is
    // watched — the rows folded into others standing on their own; its
    // count and pill counting them all.
    pub needs: Vec<ActivityRow>,
    pub watching: Vec<ActivityRow>,
    pub next: Vec<ActivityRow>,
    pub done: Vec<ActivityRow>,
    pub waiting: usize,
    pub pill: Pill,
    /// The morning brief or the wrap-up being prepared (6.4).
    pub brief: Option<super::brief::TodayBrief>,
    /// Acceptance cards on the timeline nothing can be done on any more.
    pub stale_acceptance: Vec<i32>,
    /// The handed-out work its rows point at. Filled by the command.
    pub dispatches: Vec<DispatchInfo>,
    pub day_start: DateTime<Utc>,
    pub day_end: DateTime<Utc>,
    pub as_of: DateTime<Utc>,
}

fn blank(key: String, bot_id: Option<i32>) -> ActivityRow {
    ActivityRow {
        thing: key.clone(),
        key,
        bot_id,
        today: None,
        item: None,
        routine: None,
        card_row_id: None,
        card_notice_id: None,
        hand_notice_id: None,
        folded: Vec::new(),
        why: None,
        stop: None,
        notice: None,
        pr: None,
        run: None,
        task: None,
        ask: None,
        dismiss: None,
    }
}

fn today_row(row: TodayRow, facts: &Facts) -> ActivityRow {
    // What happens on a piece of work is not the work: its own key.
    let thing = match (row.item_id, row.dispatch_id) {
        (Some(i), _) => format!("item:{i}"),
        (None, Some(d)) if !STANDS_FOR_NOTHING.contains(&row.kind) => format!("dispatch:{d}"),
        _ => row.key.clone(),
    };
    let mut out = blank(row.key.clone(), row.bot_id);
    out.thing = thing;
    out.notice = row.card.as_ref().map(|c| RowNotice {
        id: c.notice_id,
        kind: c.kind.clone(),
        phase: c.phase.clone(),
        has_message: c.has_message,
    });
    let watch = watch_of(&row).and_then(|w| facts.watches.get(&w));
    out.pr = watch.map(|w| w.pr.clone());
    // Its pull request not read as it is (6.6): whatever row stands for it
    // — its card, its own — says so, what its last read said aside.
    if let Some(WatchHealth::ReadFailed(kind)) = watch.map(|w| &w.health) {
        out.why = Some(RowWhy::ReadFailed {
            error: kind.clone(),
        });
    }
    out.task = match (row.kind, row.task_id, row.run_seq, row.task_updated_at) {
        ("task", Some(id), Some(run_seq), Some(updated_at)) => Some(RowTask {
            id,
            run_seq,
            updated_at,
            dispatch_id: row.work_dispatch_id,
        }),
        _ => None,
    };
    out.ask = row.ask.clone();
    out.today = Some(row);
    out
}

/// The watch a "today" row is of: a watched pull request's (`pr:<id>`), or
/// a card of one (its notice's payload).
fn watch_of(row: &TodayRow) -> Option<i32> {
    if row.kind == "pr" {
        return row.key.strip_prefix("pr:")?.parse().ok();
    }
    row.watch_id
}

/// Whether "today"'s `row` stands for matter `item` (B4's table): the same
/// work, the work's board task, the same matter — or the pull request the
/// work was delivered to (by the work, or by its board task: 5.3).
fn stands_for(row: &TodayRow, item: &ItemInfo, task: Option<i32>, facts: &Facts) -> bool {
    // A watched pull request's row, or a card about it, stands for the work
    // delivered to it.
    if let Some(w) = watch_of(row).and_then(|w| facts.watches.get(&w)) {
        let delivered = match item.dispatch_id {
            Some(d) if w.dispatch_id == Some(d) => true,
            Some(_) => task.is_some() && w.task_id == task,
            None => false,
        };
        if delivered || row.kind == "pr" || row.kind == "pr_ready" {
            return delivered;
        }
    }
    if STANDS_FOR_NOTHING.contains(&row.kind) {
        return false;
    }
    if row.item_id == Some(item.id) {
        return true;
    }
    match item.dispatch_id {
        Some(d) if row.dispatch_id == Some(d) => true,
        Some(_) => row.kind == "task" && task.is_some() && row.task_id == task,
        None => false,
    }
}

/// When a row of "coming up" happens: `None`, it has no time.
fn when(row: &ActivityRow) -> Option<DateTime<Utc>> {
    if let Some(r) = &row.routine {
        return r.enabled.then_some(r.next_run_at).flatten();
    }
    if let Some(t) = &row.today {
        return Some(t.at);
    }
    row.item.as_ref().and_then(|i| i.due_at)
}

fn updated(row: &ActivityRow) -> DateTime<Utc> {
    match (&row.item, &row.routine, &row.today) {
        (Some(i), _, _) => i.updated_at,
        (_, Some(r), _) => r.last_run_at.unwrap_or(r.created_at),
        (_, _, Some(t)) => t.at,
        _ => DateTime::<Utc>::MIN_UTC,
    }
}

/// What a row under way or watched is sorted by: when it began, or last
/// moved.
fn moved(row: &ActivityRow) -> DateTime<Utc> {
    match &row.today {
        Some(t) => t.at,
        None => updated(row),
    }
}

/// The work a row stands for.
fn work_of(row: &ActivityRow) -> Option<i32> {
    if row.routine.is_some() {
        return None;
    }
    row.item.as_ref().and_then(|i| i.dispatch_id).or_else(|| {
        row.today
            .as_ref()
            .filter(|t| !STANDS_FOR_NOTHING.contains(&t.kind))
            .and_then(|t| t.dispatch_id.or(t.work_dispatch_id))
    })
}

/// Which group a row goes in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Group {
    Needs,
    Running,
    Watch,
    Next,
}

/// Where a row stands: its group, why, and — under way — what stops it.
struct Place {
    group: Group,
    why: Option<RowWhy>,
    stop: Option<RowStop>,
}

impl Place {
    fn new(group: Group) -> Self {
        Self {
            group,
            why: None,
            stop: None,
        }
    }

    fn why(mut self, why: RowWhy) -> Self {
        self.why = Some(why);
        self
    }

    /// Under way, stopped by `stop`.
    fn running(stop: RowStop) -> Self {
        Self {
            group: Group::Running,
            why: None,
            stop: Some(stop),
        }
    }

    /// An input as it stands: in a turn, under way (that turn stops it);
    /// waiting for one, watched; its turn over, `ended`.
    fn of_input(s: Option<Standing>, ended: Place) -> Self {
        match s {
            Some(Standing::InTurn { bot, batch }) => {
                Self::running(RowStop::Turn { bot, batch }).why(RowWhy::InTurn { bot })
            }
            Some(Standing::Queued { bot }) => Self::new(Group::Watch).why(RowWhy::Queued { bot }),
            Some(Standing::Requeued { bot }) => {
                Self::new(Group::Watch).why(RowWhy::Redelivering { bot })
            }
            Some(Standing::Ended) => ended,
            None => Self::new(Group::Watch),
        }
    }

    /// Under way while work `id` can be stopped; watched (`why`) once it
    /// cannot — over, its outcome not read in yet.
    fn work(id: i32, live: &HashSet<i32>, why: Option<RowWhy>) -> Self {
        if live.contains(&id) {
            return Self::running(RowStop::Dispatch { id });
        }
        let p = Self::new(Group::Watch);
        match why {
            Some(w) => p.why(w),
            None => p,
        }
    }
}

/// Where "today"'s row of what is moving goes (6.3): under way when
/// something stops it, watched when it waits on something outside, the
/// owner's when nobody moves it on.
fn place_moving(row: &ActivityRow, t: &TodayRow, facts: &Facts, live: &HashSet<i32>) -> Place {
    match t.kind {
        "dispatch" => match t.dispatch_id {
            Some(id) => Place::work(id, live, None),
            None => Place::new(Group::Watch),
        },
        "task" => {
            if matches!(t.reason, Some("accepted_queued" | "merge_queued")) {
                return Place::new(Group::Watch).why(RowWhy::MergeQueued);
            }
            if t.reason == Some("looking") {
                return place_looking(t.work_dispatch_id, t.bot_id, facts);
            }
            match t.state.as_deref() {
                // The check's own work stops it — the task's is done.
                Some("checking") => match t.check_dispatch_id {
                    Some(id) => Place::work(id, live, Some(RowWhy::CheckSettling)),
                    None => Place::new(Group::Watch).why(RowWhy::CheckPreparing),
                },
                // On this machine, nothing to stop safely.
                Some("merging") => Place::new(Group::Watch).why(RowWhy::Merging),
                _ => match (t.work_dispatch_id, t.task_id) {
                    (Some(id), _) => Place::work(id, live, None),
                    (None, Some(id)) => Place::running(RowStop::Task { id, run_seq: t.run_seq }),
                    _ => Place::new(Group::Watch),
                },
            }
        }
        "failed" if t.reason == Some("looking") => place_looking(t.dispatch_id, t.bot_id, facts),
        "failed" if t.dispatch_id.is_some_and(|d| facts.handed.contains(&d)) => {
            place_looking(t.dispatch_id, t.bot_id, facts)
        }
        "pr" => place_pr(watch_of(t).and_then(|w| facts.watches.get(&w)), live),
        "routine_run" => match t.dispatch_id {
            Some(id) => Place::work(id, live, None),
            None => {
                let run = t.key.strip_prefix("routine_run:").and_then(|r| r.parse().ok());
                Place::of_input(
                    run.and_then(|r| facts.routine_runs.get(&r)).copied(),
                    Place::new(Group::Watch),
                )
            }
        },
        "reminder" => match row.item.as_ref() {
            // A follow-up come due today is a follow-up all the same.
            Some(i) if i.kind == ItemKind::Followup => place_item(i, None, row.bot_id, facts),
            Some(i) => Place::of_input(
                facts.inputs.get(&i.id).copied(),
                Place::new(Group::Needs).why(RowWhy::Unfinished),
            ),
            None => Place::new(Group::Watch),
        },
        _ => match row.item.as_ref() {
            Some(i) => place_item(i, None, row.bot_id, facts),
            None => Place::new(Group::Watch),
        },
    }
}

/// Work that just failed (B6): under way while its assistant's turn has
/// the news, waiting for that turn; the moment over, the owner's (the
/// "today" row moves to them by itself).
fn place_looking(work: Option<i32>, bot: Option<i32>, facts: &Facts) -> Place {
    match work.and_then(|d| facts.looking.get(&d)).copied() {
        Some(Standing::InTurn { bot, batch }) => {
            Place::running(RowStop::Turn { bot, batch }).why(RowWhy::Looking { bot })
        }
        _ => match bot {
            Some(bot) => Place::new(Group::Watch).why(RowWhy::Looking { bot }),
            None => Place::new(Group::Watch),
        },
    }
}

/// A watched pull request's row (6.3 e): a round fixing it went in that
/// work's row already; a card about it stands for it.
fn place_pr(w: Option<&WatchFacts>, live: &HashSet<i32>) -> Place {
    let Some(w) = w else {
        return Place::new(Group::Watch);
    };
    // Not read as it is (6.6): what it says may be old — the owner's to
    // see to, before anything its last read said.
    if let WatchHealth::ReadFailed(kind) = &w.health {
        return Place::new(Group::Needs).why(RowWhy::ReadFailed {
            error: kind.clone(),
        });
    }
    match w.phase.as_deref() {
        Some(p @ ("checks_failed" | "conflict")) => {
            if let Some(id) = w.fixing {
                return Place::work(id, live, None).why(RowWhy::Fixing);
            }
            if w.fix_pending {
                return Place::new(Group::Watch).why(RowWhy::FixPending);
            }
            let cause = if p == "conflict" { "conflict" } else { "checks" };
            Place::new(Group::Needs).why(RowWhy::NobodyFixing { cause })
        }
        Some("waiting_checks") => match &w.health {
            WatchHealth::ChecksSlow(hours) => {
                Place::new(Group::Needs).why(RowWhy::ChecksSlow { hours: *hours })
            }
            _ => Place::new(Group::Watch),
        },
        Some("open") => match &w.health {
            WatchHealth::ReviewSlow(days) => {
                Place::new(Group::Needs).why(RowWhy::ReviewSlow { days: *days })
            }
            WatchHealth::ReviewPending => Place::new(Group::Watch).why(RowWhy::ReviewPending),
            _ => Place::new(Group::Watch).why(RowWhy::PlatformBlocked),
        },
        // Ready to merge, its card gone (seen, put aside): still the
        // owner's to merge — on its own row, which merges it.
        Some("mergeable") => Place::new(Group::Needs),
        _ => Place::new(Group::Watch),
    }
}

/// A matter of its own, no "today" row standing for it (6.3 a–d), or the
/// one of a finished row it took with it (`card`: its reminder card).
/// `bot`: whose matter it is — who picks its failed work up, once the owner
/// handed it over.
fn place_item(item: &ItemInfo, card: Option<&ItemCard>, bot: Option<i32>, facts: &Facts) -> Place {
    let input = facts.inputs.get(&item.id).copied();
    match item.kind {
        // First: a follow-up is never "under way" for waiting on an agent
        // alone.
        ItemKind::Followup => match item.waits_for {
            Some(WaitsFor::Owner) => Place::new(Group::Needs),
            _ if matches!(input, Some(Standing::InTurn { .. })) => {
                Place::of_input(input, Place::new(Group::Next))
            }
            _ if item.due_at.is_some() => Place::new(Group::Next),
            Some(WaitsFor::Agent | WaitsFor::External) => {
                Place::new(Group::Next).why(RowWhy::NoTrigger)
            }
            _ => Place::new(Group::Next),
        },
        ItemKind::Message => match facts.messages.get(&item.id).copied() {
            // Its receiver's turn over without an answer: theirs to chase
            // or let go.
            Some(Standing::Ended) => match item.waits_for {
                Some(WaitsFor::Agent | WaitsFor::External) => {
                    let peer = item
                        .peer
                        .as_ref()
                        .and_then(|p| p["id"].as_i64())
                        .and_then(|p| i32::try_from(p).ok())
                        .unwrap_or_default();
                    Place::new(Group::Needs).why(RowWhy::NoReply { peer })
                }
                _ => by_wait(item),
            },
            Some(s) => Place::of_input(Some(s), Place::new(Group::Needs)),
            None => by_wait(item),
        },
        // A reminder that fired stands as its card does: open, the
        // owner's; handed, as its assistant's turn has it.
        ItemKind::Reminder => match card {
            Some(c) if c.open => Place::new(Group::Needs),
            Some(c) if c.handed => {
                Place::of_input(input, Place::new(Group::Needs).why(RowWhy::Unfinished))
            }
            _ if item.waits_for == Some(WaitsFor::Agent) && input.is_some() => {
                Place::of_input(input, Place::new(Group::Needs).why(RowWhy::Unfinished))
            }
            _ => by_wait(item),
        },
        ItemKind::Question if item.waits_for != Some(WaitsFor::Owner) && input.is_some() => {
            Place::of_input(input, Place::new(Group::Watch))
        }
        // Work that failed is the owner's, whatever it says it waits on
        // (6.3 d) — unless they saw to it already: its assistant's.
        ItemKind::Dispatch
            if matches!(
                item.dispatch_state,
                Some(DispatchState::Failed | DispatchState::Interrupted)
            ) =>
        {
            if item.dispatch_id.is_some_and(|d| facts.handed.contains(&d)) {
                place_looking(item.dispatch_id, bot, facts)
            } else {
                Place::new(Group::Needs).why(RowWhy::Failed)
            }
        }
        // Delivered, and no watch stands for it any more: nobody tells its
        // merge — the owner's to close.
        ItemKind::Dispatch
            if item.dispatch_state == Some(DispatchState::Completed)
                && item.waits_for == Some(WaitsFor::External) =>
        {
            Place::new(Group::Needs)
        }
        _ => by_wait(item),
    }
}

/// As a matter says it waits: on the owner, theirs; on an agent or
/// something outside, watched; on the clock (or nothing), coming up.
fn by_wait(item: &ItemInfo) -> Place {
    match item.waits_for {
        Some(WaitsFor::Owner) => Place::new(Group::Needs),
        Some(WaitsFor::External | WaitsFor::Agent) => Place::new(Group::Watch),
        _ => Place::new(Group::Next),
    }
}

/// Where a row waiting on the owner comes in its group (6.3): 0, what
/// something is stuck on (an approval, a question, input, a failure, a pull
/// request nobody fixes, a message with no answer); 1, what asks the owner
/// to decide or confirm; 2, a reminder come due.
fn needs_rank(row: &ActivityRow) -> u8 {
    if matches!(
        row.why,
        Some(
            RowWhy::NoReply { .. }
                | RowWhy::Unfinished
                | RowWhy::NobodyFixing { .. }
                | RowWhy::Failed
        )
    ) {
        return 0;
    }
    match row.today.as_ref() {
        Some(t) => match t.kind {
            "approval" | "forwarded" | "question" | "waiting" | "session" | "failed" | "stuck"
            | "used_up" | "plan_stuck" | "routine_paused" => 0,
            "task" if t.reason == Some("failed") || t.state.as_deref() == Some("awaiting_input") => 0,
            // A question come due asks the owner as a question does.
            "reminder" if row.item.as_ref().is_some_and(|i| i.kind == ItemKind::Question) => 0,
            "reminder" => 2,
            _ => 1,
        },
        None => match row.item.as_ref().map(|i| i.kind) {
            Some(ItemKind::Question) => 0,
            Some(ItemKind::Reminder) => 2,
            _ => 1,
        },
    }
}

/// Whether a row waiting on the owner is a suggestion (5.2): by its kind,
/// never its level.
fn is_suggestion(row: &ActivityRow) -> bool {
    row.today.as_ref().is_some_and(|t| match t.kind {
        "proposal" | "tidy" | "skill" => true,
        "rule" => matches!(t.state.as_deref(), Some("uncommitted" | "idle")),
        _ => false,
    })
}

/// A message an assistant waits on an answer to, while its receiver does
/// work for it, is one chain with that work: the message goes in the
/// work's row (C1, each thing once) — "the primary waits on the
/// engineer's answer" under the engineer's running work, not a row of its
/// own beside it — wherever either is. Only the primary's page has both;
/// elsewhere the message stands alone. Nothing is lost: a message whose
/// work's row is not there stays where it is.
fn fold_messages(
    groups: [&mut Vec<ActivityRow>; 3],
    messages: &HashMap<i32, SentMessage>,
    works: &HashMap<i32, WorkSource>,
) {
    let [needs, running, watch] = groups;
    // The work a row stands for, where it came from: none for a message's.
    let source = |r: &ActivityRow| {
        if r.item.as_ref().is_some_and(|i| i.kind == ItemKind::Message) {
            return None;
        }
        work_of(r).and_then(|d| works.get(&d))
    };
    // Each message's row, and whether it waits on the owner (no reply): one
    // that does goes only in work still under way for it — never out of
    // sight in what is watched.
    // One under way in its receiver's turn goes only in a row stopped the
    // same way: its [Stop] is not lost in it.
    let waiting: Vec<(String, SentMessage, bool, Option<RowStop>)> = needs
        .iter()
        .map(|r| (r, true))
        .chain(running.iter().map(|r| (r, false)))
        .chain(watch.iter().map(|r| (r, false)))
        .filter_map(|(row, owners)| {
            row.item
                .as_ref()
                .filter(|i| i.kind == ItemKind::Message)
                .and_then(|i| messages.get(&i.id))
                .map(|m| (row.key.clone(), *m, owners, row.stop))
        })
        .collect();
    // Each message's row, by key, and the key of the work's row it goes in:
    // the work made for it; else the one work on its thread, when it is the
    // one message waiting on that thread — a thread is a whole talk, and
    // two messages on it, or two pieces of work, would be a guess.
    let mut plan: HashMap<String, String> = HashMap::new();
    {
        let all = || needs.iter().chain(running.iter()).chain(watch.iter());
        for (key, m, owners, stop) in &waiting {
            let rows = || {
                all()
                    .filter(|r| !*owners || running.iter().any(|x| x.key == r.key))
                    .filter(|r| stop.is_none() || r.stop == *stop)
            };
            let lead = match rows().find(|r| source(r).is_some_and(|w| w.made_for(m))) {
                Some(r) => Some(r),
                None => {
                    let alone = waiting
                        .iter()
                        .filter(|(_, o, _, _)| o.to_bot == m.to_bot && o.thread == m.thread)
                        .count()
                        == 1;
                    let mut on = rows().filter(|r| source(r).is_some_and(|w| w.on_thread_of(m)));
                    match (on.next(), on.next()) {
                        (Some(r), None) if alone => Some(r),
                        _ => None,
                    }
                }
            };
            if let Some(lead) = lead {
                plan.insert(key.clone(), lead.key.clone());
            }
        }
    }
    if plan.is_empty() {
        return;
    }
    let mut folded: Vec<(ActivityRow, usize)> = Vec::new();
    for (at, group) in [&mut *needs, &mut *running, &mut *watch].into_iter().enumerate() {
        let (out, kept): (Vec<_>, Vec<_>) = std::mem::take(group)
            .into_iter()
            .partition(|r| plan.contains_key(&r.key));
        *group = kept;
        folded.extend(out.into_iter().map(|r| (r, at)));
    }
    for (row, at) in folded {
        let lead = &plan[&row.key];
        let found = needs
            .iter_mut()
            .chain(running.iter_mut())
            .chain(watch.iter_mut())
            .find(|r| &r.key == lead);
        match found {
            Some(r) => r.folded.push(row),
            // Never lost: it stands where it was.
            None => [&mut *needs, &mut *running, &mut *watch][at].push(row),
        }
    }
}

/// An older page's rows (11): each folded row on its own after the one it
/// was in.
fn unfolded(rows: &[ActivityRow]) -> Vec<ActivityRow> {
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let mut lead = r.clone();
        let folded = std::mem::take(&mut lead.folded);
        out.push(lead);
        out.extend(folded);
    }
    out
}

pub fn merge(inp: Inputs) -> ActivityView {
    let Inputs {
        bot,
        primary,
        today,
        items,
        item_bots,
        item_tasks,
        item_cards,
        item_messages,
        works,
        facts,
        live_work,
        routines,
        dismissed,
        as_of,
    } = inp;
    // A work assistant's page has its own rows of "today"; the primary's,
    // every assistant's and the owner's own.
    let mine = |r: &TodayRow| primary || r.bot_id == Some(bot);
    // Its own routines are rows of their own, which do more.
    let own_routine = |r: &TodayRow| {
        r.kind == "routine"
            && r.routine_id
                .is_some_and(|id| routines.iter().any(|x| x.id == id))
    };
    let take = |rows: Vec<TodayRow>| -> Vec<ActivityRow> {
        rows.into_iter()
            .filter(|r| mine(r) && !own_routine(r))
            .map(|r| today_row(r, &facts))
            .collect()
    };
    let mut needs = take(today.needs);
    // What is moving: placed once its matters are in it (6.3).
    let mut moving = take(today.watching);
    let mut next = take(today.schedule);
    let mut done = take(today.done);
    // A board task in review whose work was delivered as a pull request is
    // that pull request's row (5.3) — the watch's own, or the card that
    // stands for it while it can be merged — not a second one. A later run
    // of it (failed, asking for input) is its own.
    let shown: Vec<&WatchFacts> = moving
        .iter()
        .chain(needs.iter())
        .filter_map(|r| r.today.as_ref().and_then(watch_of))
        .filter_map(|w| facts.watches.get(&w))
        .collect();
    // ... the run delivered: one begun after the delivery (sent back,
    // fixed) is the owner's to look at again.
    let delivered = |t: &TodayRow| {
        shown.iter().any(|w| {
            let same = t.work_dispatch_id.is_some_and(|d| w.dispatch_id == Some(d))
                || t.task_id.is_some_and(|id| w.task_id == Some(id));
            same && t.run_started_at.is_none_or(|s| s <= w.since)
        })
    };
    needs.retain(|r| {
        !r.today.as_ref().is_some_and(|t| {
            t.kind == "task" && t.state.as_deref() == Some("review") && delivered(t)
        })
    });
    // Merged today: one row, the merge's, not also "finished" (5.3).
    let merged: HashSet<i32> = done
        .iter()
        .filter_map(|r| r.today.as_ref().filter(|t| t.kind == "pr_merged"))
        .filter_map(|t| t.dispatch_id)
        .collect();
    done.retain(|r| {
        !r.today.as_ref().is_some_and(|t| {
            t.kind == "finished" && t.dispatch_id.is_some_and(|d| merged.contains(&d))
        })
    });

    // Each matter: in the row that stands for it (its assistant's), or a
    // row of its own, placed as it stands.
    let mut own: Vec<(ActivityRow, Place)> = Vec::new();
    for item in items {
        let task = item.dispatch_id.and_then(|d| item_tasks.get(&d).copied());
        let of = item_bots.get(&item.id).copied().unwrap_or(bot);
        let stands = |r: &ActivityRow| {
            r.item.is_none()
                && r.today
                    .as_ref()
                    .is_some_and(|t| t.bot_id == Some(of) && stands_for(t, &item, task, &facts))
        };
        // Its work's own row before a pull request's: a later run that
        // failed is that run's, not the delivered one's.
        let is_watch = |r: &ActivityRow| r.today.as_ref().and_then(watch_of).is_some();
        let open_card = item_cards
            .get(&item.id)
            .filter(|c| c.open)
            .map(|c| c.notice_id);
        // Handed to its assistant, or come due for it to do: what [Hand it
        // again] answers once its turn on it is over (6.5).
        let handed_card = item_cards
            .get(&item.id)
            .filter(|c| c.handed || c.woke)
            .map(|c| c.notice_id);
        let work_first = needs
            .iter()
            .chain(moving.iter())
            .chain(next.iter())
            .any(|r| stands(r) && !is_watch(r));
        let standing = needs
            .iter_mut()
            .chain(moving.iter_mut())
            .chain(next.iter_mut())
            .find(|r| stands(r) && !(work_first && is_watch(r)));
        if let Some(row) = standing {
            // Delivered to a watched pull request: its row stands for the
            // work, the work's "finished" with it (5.3).
            let delivered = row.pr.is_some() && item.dispatch_id.is_some();
            row.thing = format!("item:{}", item.id);
            row.card_notice_id = open_card;
            row.hand_notice_id = handed_card;
            if delivered {
                done.retain(|r| {
                    !r.today.as_ref().is_some_and(|t| {
                        t.kind == "finished" && t.dispatch_id == item.dispatch_id
                    })
                });
            }
            row.item = Some(item);
            continue;
        }
        // Work done today whose matter still waits is not done: its row
        // goes with the matter.
        let finished = done.iter().position(&stands).map(|at| done.remove(at));
        let card = item_cards.get(&item.id).copied();
        // A card neither open nor handed (closed) is no reminder to view.
        let card = card.filter(|c| {
            (c.open || c.handed)
                && matches!(item.waits_for, Some(WaitsFor::Owner | WaitsFor::Agent))
        });
        let place = place_item(&item, card.as_ref(), Some(of), &facts);
        let mut row = finished.unwrap_or_else(|| blank(format!("item:{}", item.id), Some(of)));
        row.thing = format!("item:{}", item.id);
        row.bot_id = Some(of);
        row.card_row_id = card.map(|c| c.row_id);
        row.card_notice_id = open_card;
        row.hand_notice_id = handed_card;
        row.item = Some(item);
        own.push((row, place));
    }

    // A routine's run that handed out work is that work's (5.3): its name
    // on the work's row, not a row of its own. A pull request a round is
    // fixing is that work's too, the row saying so; one a card asks about,
    // the card's. A matter goes with it, unless the row it goes in has one.
    let lead_of = |rows: &[ActivityRow], work: i32, not: &str| {
        rows.iter().position(|o| {
            o.today.as_ref().is_some_and(|t| {
                t.kind != not && (t.dispatch_id == Some(work) || t.work_dispatch_id == Some(work))
            })
        })
    };
    let mut gone: HashSet<usize> = HashSet::new();
    // A routine's run whose work waits on the owner (its input): that row's.
    let mut runs_to_needs: Vec<(usize, usize)> = Vec::new();
    for at in 0..moving.len() {
        let Some(t) = moving[at].today.as_ref() else {
            continue;
        };
        if t.kind == "routine_run" {
            let Some(work) = t.dispatch_id else {
                continue;
            };
            let Some(l) = lead_of(&moving, work, "routine_run") else {
                if let Some(n) = lead_of(&needs, work, "routine_run") {
                    runs_to_needs.push((at, n));
                }
                continue;
            };
            let run = RunRef {
                run_id: t
                    .key
                    .strip_prefix("routine_run:")
                    .and_then(|r| r.parse().ok())
                    .unwrap_or_default(),
                routine_id: t.routine_id.unwrap_or_default(),
                title: t.title.clone(),
            };
            if moving[at].item.is_some() && moving[l].item.is_some() {
                continue;
            }
            let item = moving[at].item.take();
            let lead = &mut moving[l];
            lead.run = Some(run);
            if let Some(i) = item {
                lead.thing = format!("item:{}", i.id);
                lead.item = Some(i);
            }
            gone.insert(at);
            continue;
        }
        let Some(w) = (t.kind == "pr").then(|| watch_of(t)).flatten() else {
            continue;
        };
        let fixing = facts.watches.get(&w).and_then(|f| f.fixing);
        if let Some(l) = fixing.and_then(|f| lead_of(&moving, f, "pr")) {
            if moving[at].item.is_none() || moving[l].item.is_none() {
                let (pr, item) = (moving[at].pr.clone(), moving[at].item.take());
                let lead = &mut moving[l];
                lead.pr = pr;
                lead.why = Some(RowWhy::Fixing);
                if let Some(i) = item {
                    lead.thing = format!("item:{}", i.id);
                    lead.item = Some(i);
                }
                gone.insert(at);
                continue;
            }
        }
        let card = needs
            .iter()
            .position(|n| n.today.as_ref().and_then(|t| t.watch_id) == Some(w));
        if let Some(c) = card {
            if moving[at].item.is_none() || needs[c].item.is_none() {
                let (pr, item) = (moving[at].pr.clone(), moving[at].item.take());
                let lead = &mut needs[c];
                lead.pr = pr;
                if let Some(i) = item {
                    lead.thing = format!("item:{}", i.id);
                    lead.item = Some(i);
                }
                gone.insert(at);
            }
        }
    }
    for (at, n) in runs_to_needs {
        let Some(t) = moving[at].today.as_ref() else {
            continue;
        };
        let run = RunRef {
            run_id: t
                .key
                .strip_prefix("routine_run:")
                .and_then(|r| r.parse().ok())
                .unwrap_or_default(),
            routine_id: t.routine_id.unwrap_or_default(),
            title: t.title.clone(),
        };
        if moving[at].item.is_some() && needs[n].item.is_some() {
            continue;
        }
        let item = moving[at].item.take();
        let lead = &mut needs[n];
        lead.run = Some(run);
        if let Some(i) = item {
            lead.thing = format!("item:{}", i.id);
            lead.item = Some(i);
        }
        gone.insert(at);
    }
    let moving: Vec<ActivityRow> = moving
        .into_iter()
        .enumerate()
        .filter(|(at, _)| !gone.contains(at))
        .map(|(_, r)| r)
        .collect();

    // Each in its place (6.3): what stops it first, then its group.
    let mut running: Vec<ActivityRow> = Vec::new();
    let mut watch: Vec<ActivityRow> = Vec::new();
    let mut promoted: Vec<ActivityRow> = Vec::new();
    let mut put = |mut row: ActivityRow, p: Place, next: &mut Vec<ActivityRow>| {
        if p.why.is_some() {
            row.why = p.why;
        }
        match (p.group, p.stop) {
            (Group::Running, Some(stop)) => {
                row.stop = Some(stop);
                running.push(row);
            }
            // Nothing stops it: watched, never under way (5.2).
            (Group::Running, None) => watch.push(row),
            (Group::Watch, _) => watch.push(row),
            (Group::Needs, _) => promoted.push(row),
            (Group::Next, _) => next.push(row),
        }
    };
    // Failed work the owner saw to already (handed to its assistant): its
    // assistant's now, out of what waits on them.
    let (seen_to, waiting): (Vec<ActivityRow>, Vec<ActivityRow>) =
        needs.into_iter().partition(|r| {
            r.today.as_ref().is_some_and(|t| {
                let work = match t.kind {
                    "failed" => t.dispatch_id,
                    "task" if t.reason == Some("failed") => t.work_dispatch_id,
                    _ => None,
                };
                work.is_some_and(|d| facts.handed.contains(&d))
            })
        });
    let mut needs = waiting;
    for row in seen_to {
        let p = match row.today.as_ref() {
            Some(t) => place_looking(t.dispatch_id.or(t.work_dispatch_id), t.bot_id, &facts),
            None => Place::new(Group::Watch),
        };
        put(row, p, &mut next);
    }
    for row in moving {
        let p = match row.today.as_ref() {
            Some(t) => place_moving(&row, t, &facts, &live_work),
            None => Place::new(Group::Watch),
        };
        put(row, p, &mut next);
    }
    for (row, p) in own {
        put(row, p, &mut next);
    }
    // What blocks something first, then what asks the owner to decide,
    // then reminders; within each, the longest waiting first (6.3).
    needs.extend(promoted);
    needs.sort_by_key(|r| (needs_rank(r), moved(r)));
    running.sort_by_key(|r| std::cmp::Reverse(moved(r)));
    watch.sort_by_key(|r| std::cmp::Reverse(moved(r)));

    // The suggestions: the owner's, one line (5.2).
    let (mut suggestions, mut needs): (Vec<_>, Vec<_>) =
        needs.into_iter().partition(is_suggestion);
    fold_messages([&mut needs, &mut running, &mut watch], &item_messages, &works);
    debug_assert!(running.iter().all(|r| r.stop.is_some()), "{running:#?}");
    // Each the owner can ignore as it stands — a suggestion too; one they
    // ignored so, out — the tab's count and the pill without it.
    for row in needs.iter_mut().chain(suggestions.iter_mut()) {
        row.dismiss = Some(dismiss_mark(row));
    }
    let kept = |r: &ActivityRow| r.dismiss.as_ref().is_none_or(|m| !dismissed.contains(m));
    needs.retain(kept);
    suggestions.retain(kept);

    // Its routines, coming up with the rest.
    next.extend(routines.into_iter().map(|r| {
        let mut row = blank(format!("routine:{}", r.id), Some(r.bot_id));
        row.routine = Some(r);
        row
    }));
    // By when it happens; what has no time after, the latest changed
    // first; a paused routine last.
    next.sort_by_key(|r| {
        let paused = r.routine.as_ref().is_some_and(|x| !x.enabled);
        match when(r) {
            Some(t) if !paused => (0u8, t, std::cmp::Reverse(DateTime::<Utc>::MIN_UTC)),
            _ => (
                1 + u8::from(paused),
                DateTime::<Utc>::MIN_UTC,
                std::cmp::Reverse(updated(r)),
            ),
        }
    });

    let pill = Pill {
        count: needs.len(),
        first: needs.first().map(|r| r.key.clone()),
    };
    let groups = ActivityGroups {
        waiting: needs.len(),
        pill,
        needs,
        suggestions,
        running,
        watch,
        next,
        done,
    };
    // An older page's (11).
    let mut old_needs = unfolded(&groups.needs);
    old_needs.extend(unfolded(&groups.suggestions));
    let mut old_watching = unfolded(&groups.running);
    old_watching.extend(unfolded(&groups.watch));
    let old_pill = Pill {
        count: old_needs.len(),
        first: old_needs.first().map(|r| r.key.clone()),
    };
    ActivityView {
        capabilities: CAPABILITIES.to_vec(),
        waiting: old_needs.len(),
        pill: old_pill,
        needs: old_needs,
        watching: old_watching,
        next: unfolded(&groups.next),
        // A row kind an older page has no words for (a watch given up
        // today, 6.6) is the new groups' alone.
        done: unfolded(&groups.done)
            .into_iter()
            .filter(|r| r.today.as_ref().is_none_or(|t| t.kind != "pr_gone"))
            .collect(),
        groups,
        brief: today.brief,
        stale_acceptance: today.stale_acceptance,
        dispatches: Vec::new(),
        day_start: today.day_start,
        day_end: today.day_end,
        as_of,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::entities::personal_agent_dispatch::DispatchState;
    use crate::db::entities::personal_agent_item::{ItemKind, ItemStatus};

    fn item(id: i32, waits_for: Option<WaitsFor>, dispatch: Option<i32>) -> ItemInfo {
        let at = Utc::now();
        ItemInfo {
            id,
            kind: ItemKind::Reminder,
            dispatch_id: dispatch,
            status: ItemStatus::Waiting,
            waits_for,
            summary: format!("#{id}"),
            on_done: None,
            origin_timeline_id: None,
            created_at: at,
            updated_at: at,
            dispatch_state: dispatch.map(|_| DispatchState::Completed),
            due_at: None,
            repeat: None,
            at_due: None,
            act_spec: None,
            fired_at: None,
            mention: None,
            closed_at: None,
            closed_by: None,
            closed_how: None,
            answer_row_id: None,
            answer_state: None,
            peer: None,
            written: None,
            direction: None,
        }
    }

    fn inputs(bot: i32, primary: bool, today: TodayView, items: Vec<(ItemInfo, i32)>) -> Inputs {
        Inputs {
            bot,
            primary,
            today,
            item_bots: items.iter().map(|(i, b)| (i.id, *b)).collect(),
            items: items.into_iter().map(|(i, _)| i).collect(),
            item_tasks: HashMap::new(),
            item_cards: HashMap::new(),
            item_messages: HashMap::new(),
            works: HashMap::new(),
            facts: Facts::default(),
            // Every piece of work the tests name can be stopped, unless a
            // test says otherwise.
            live_work: (1..=200).collect(),
            routines: Vec::new(),
            dismissed: HashSet::new(),
            as_of: Utc::now(),
        }
    }

    /// The primary (1) waiting on the engineer's (3) answer to message 10,
    /// on thread 10, while the engineer runs work 9 — made for `for_input`
    /// on `thread`.
    fn message_and_work(for_input: Option<&str>, thread: Option<i32>, work_bot: i32) -> Inputs {
        let mut today = TodayView::default();
        let mut work = TodayRow::new("dispatch:9".into(), "dispatch", "Fix".into(), Utc::now());
        work.bot_id = Some(work_bot);
        work.dispatch_id = Some(9);
        today.watching.push(work);
        let mut message = item(2, Some(WaitsFor::Agent), None);
        message.kind = ItemKind::Message;
        let mut inp = inputs(
            1,
            true,
            today,
            vec![
                (item(3, Some(WaitsFor::External), Some(9)), work_bot),
                (message, 1),
            ],
        );
        inp.item_messages.insert(
            2,
            SentMessage {
                id: 10,
                thread: Some(10),
                to_bot: 3,
            },
        );
        inp.works.insert(
            9,
            WorkSource {
                bot: Some(work_bot),
                for_input: for_input.map(str::to_string),
                thread,
            },
        );
        inp
    }

    /// A message waiting on the work its receiver does for it is one chain:
    /// one row, the work's, the message in it.
    #[test]
    fn a_message_goes_in_the_row_of_the_work_done_for_it() {
        for (for_input, thread) in [(Some("message:10"), None), (None, Some(10))] {
            let v = merge(message_and_work(for_input, thread, 3));
            assert_eq!(
                moving(&v).len(),
                1,
                "{for_input:?} {thread:?}: {:#?}",
                v.groups
            );
            let row = &v.groups.running[0];
            assert_eq!(row.thing, "item:3");
            assert_eq!(row.folded.len(), 1);
            assert_eq!(row.folded[0].thing, "item:2");
            assert_eq!(
                row.folded[0].bot_id,
                Some(1),
                "its actions go to its sender"
            );
            assert_eq!(all(&v).len(), 1);
        }
    }

    /// Two messages waiting on one thread: the work made for one goes with
    /// it; work on the thread made for neither is a guess, and neither
    /// goes.
    #[test]
    fn a_thread_with_two_messages_folds_only_by_the_message() {
        let second = |inp: &mut Inputs| {
            let mut m = item(5, Some(WaitsFor::Agent), None);
            m.kind = ItemKind::Message;
            inp.items.push(m);
            inp.item_bots.insert(5, 1);
            inp.item_messages.insert(
                5,
                SentMessage {
                    id: 12,
                    thread: Some(10),
                    to_bot: 3,
                },
            );
        };
        let mut inp = message_and_work(Some("message:12"), Some(10), 3);
        second(&mut inp);
        let v = merge(inp);
        assert_eq!(moving(&v).len(), 2, "{:#?}", v.groups);
        let work = moving(&v).into_iter().find(|r| r.thing == "item:3").unwrap();
        assert_eq!(work.folded.len(), 1);
        assert_eq!(work.folded[0].thing, "item:5");

        let mut inp = message_and_work(Some("event:1"), Some(10), 3);
        second(&mut inp);
        let v = merge(inp);
        assert_eq!(moving(&v).len(), 3);
        assert!(moving(&v).iter().all(|r| r.folded.is_empty()));
    }

    /// Work on another message or thread, or another assistant's, is not
    /// the answer: the message stands alone.
    #[test]
    fn a_message_stands_alone_beside_other_work() {
        for (for_input, thread, bot) in [
            (Some("message:11"), Some(11), 3),
            (None, None, 3),
            (Some("message:10"), Some(10), 4),
        ] {
            let v = merge(message_and_work(for_input, thread, bot));
            assert_eq!(moving(&v).len(), 2, "{for_input:?} {thread:?} {bot}");
            assert!(moving(&v).iter().all(|r| r.folded.is_empty()));
        }
    }

    /// Every row of the groups, the suggestions among them — not the ones
    /// folded into others.
    fn all(v: &ActivityView) -> Vec<&ActivityRow> {
        let g = &v.groups;
        g.needs
            .iter()
            .chain(&g.suggestions)
            .chain(&g.running)
            .chain(&g.watch)
            .chain(&g.next)
            .chain(&g.done)
            .collect()
    }

    /// What is under way and what is watched.
    fn moving(v: &ActivityView) -> Vec<&ActivityRow> {
        v.groups.running.iter().chain(&v.groups.watch).collect()
    }

    /// A pull request delivered today waits on its merge: one row, under
    /// way, with the work's row of it — not also done.
    #[test]
    fn work_done_whose_matter_still_waits_is_under_way_once() {
        let mut today = TodayView::default();
        let mut finished = TodayRow::new("finished:7".into(), "finished", "Fix".into(), Utc::now());
        finished.bot_id = Some(2);
        finished.dispatch_id = Some(7);
        today.done.push(finished);
        let v = merge(inputs(
            2,
            false,
            today,
            vec![(item(1, Some(WaitsFor::External), Some(7)), 2)],
        ));
        assert!(v.groups.done.is_empty(), "{:#?}", v.groups.done);
        assert_eq!(v.groups.watch.len(), 1);
        let row = &v.groups.watch[0];
        assert_eq!(
            (row.key.as_str(), row.thing.as_str()),
            ("finished:7", "item:1")
        );
        assert!(row.item.is_some() && row.today.is_some());
        assert_eq!(all(&v).len(), 1);
    }

    /// The primary's page has every assistant's matters, each folded into
    /// its own assistant's row of "today".
    #[test]
    fn the_primary_page_folds_each_matter_into_its_own_assistants_row() {
        let mut today = TodayView::default();
        let mut row = TodayRow::new("dispatch:9".into(), "dispatch", "Run".into(), Utc::now());
        row.bot_id = Some(5);
        row.dispatch_id = Some(9);
        today.watching.push(row);
        let v = merge(inputs(
            1,
            true,
            today,
            vec![
                (item(3, Some(WaitsFor::External), Some(9)), 5),
                (item(4, Some(WaitsFor::Owner), None), 5),
            ],
        ));
        assert_eq!(v.groups.running.len(), 1);
        assert_eq!(v.groups.running[0].thing, "item:3");
        assert_eq!(v.groups.running[0].stop, Some(RowStop::Dispatch { id: 9 }));
        assert_eq!(
            v.groups.needs.len(),
            1,
            "another assistant's matter waiting on the owner"
        );
        assert_eq!(
            v.groups.needs[0].bot_id,
            Some(5),
            "its actions go to its assistant"
        );
        assert_eq!((v.groups.waiting, v.waiting), (1, 1));
    }

    /// A card neither open nor handed (closed) is no reminder to view; the
    /// matter stands as it waits.
    #[test]
    fn a_closed_card_is_not_linked() {
        let mut inp = inputs(
            2,
            false,
            TodayView::default(),
            vec![(item(1, Some(WaitsFor::Owner), None), 2)],
        );
        inp.item_cards.insert(
            1,
            ItemCard {
                row_id: 40,
                notice_id: 41,
                open: false,
                handed: false,
                woke: false,
                hand_row: None,
            },
        );
        let v = merge(inp);
        assert_eq!(v.groups.needs.len(), 1);
        assert_eq!(v.groups.needs[0].card_row_id, None);

        let mut inp = inputs(
            2,
            false,
            TodayView::default(),
            vec![(item(1, Some(WaitsFor::Owner), None), 2)],
        );
        inp.item_cards.insert(
            1,
            ItemCard {
                row_id: 40,
                notice_id: 41,
                open: false,
                handed: true,
                woke: false,
                hand_row: None,
            },
        );
        let v = merge(inp);
        assert_eq!(
            (v.groups.watch.len(), v.groups.watch[0].card_row_id),
            (1, Some(40)),
            "handed, its turn not known: watched"
        );
        assert_eq!(v.groups.waiting, 0);
    }

    // ── M1: the groups (5.2) ────────────────────────────────────────────

    /// "Today"'s row `key` of `kind` (assistant 2's).
    fn trow(key: &str, kind: &'static str) -> TodayRow {
        let mut r = TodayRow::new(key.into(), kind, key.into(), Utc::now());
        r.bot_id = Some(2);
        r
    }

    fn with(today: TodayView, items: Vec<ItemInfo>, facts: Facts) -> ActivityView {
        let mut inp = inputs(2, false, today, items.into_iter().map(|i| (i, 2)).collect());
        inp.facts = facts;
        merge(inp)
    }

    fn moving_view(rows: Vec<TodayRow>, items: Vec<ItemInfo>, facts: Facts) -> ActivityView {
        let today = TodayView {
            watching: rows,
            ..TodayView::default()
        };
        with(today, items, facts)
    }

    /// The row with `key`, in whichever group it is, and that group.
    fn find<'a>(v: &'a ActivityView, key: &str) -> (&'static str, &'a ActivityRow) {
        let g = &v.groups;
        for (name, rows) in [
            ("needs", &g.needs),
            ("suggestions", &g.suggestions),
            ("running", &g.running),
            ("watch", &g.watch),
            ("next", &g.next),
            ("done", &g.done),
        ] {
            if let Some(r) = rows.iter().find(|r| r.key == key) {
                return (name, r);
            }
        }
        panic!("no row {key}: {g:#?}");
    }

    fn invariants(v: &ActivityView) {
        let g = &v.groups;
        assert!(g.running.iter().all(|r| r.stop.is_some()), "{:#?}", g.running);
        let mut things = HashSet::new();
        for r in all(v) {
            assert!(things.insert(r.thing.clone()), "{} twice: {g:#?}", r.thing);
            for f in &r.folded {
                assert!(things.insert(f.thing.clone()), "{} twice: {g:#?}", f.thing);
            }
        }
        assert_eq!((g.waiting, g.pill.count), (g.needs.len(), g.needs.len()));
        assert_eq!(g.pill.first, g.needs.first().map(|r| r.key.clone()));
        // An older page's: the suggestions counted, every folded row on its
        // own (as that page drew them).
        assert_eq!(v.waiting, v.needs.len());
        assert_eq!(v.pill.count, v.waiting);
        let flat = |rows: &[ActivityRow]| rows.iter().map(|r| 1 + r.folded.len()).sum::<usize>();
        assert_eq!(v.needs.len(), flat(&g.needs) + flat(&g.suggestions));
        assert_eq!(v.watching.len(), flat(&g.running) + flat(&g.watch));
        assert!(v.watching.iter().chain(&v.needs).all(|r| r.folded.is_empty()));
        assert_eq!(v.capabilities, CAPABILITIES.to_vec());
    }

    /// Work and board tasks: what stops each, or where it waits when
    /// nothing does.
    #[test]
    fn work_under_way_has_what_stops_it_and_the_rest_is_watched() {
        let mut d = trow("dispatch:9", "dispatch");
        d.dispatch_id = Some(9);
        let mut handed = trow("task:1", "task");
        handed.task_id = Some(1);
        handed.state = Some("running".into());
        handed.work_dispatch_id = Some(11);
        let mut own = trow("task:2", "task");
        own.task_id = Some(2);
        own.state = Some("preparing".into());
        own.run_seq = Some(4);
        own.bot_id = None;
        let mut checking = trow("task:3", "task");
        checking.task_id = Some(3);
        checking.state = Some("checking".into());
        checking.check_dispatch_id = Some(30);
        checking.work_dispatch_id = Some(13);
        let mut preparing = trow("task:4", "task");
        preparing.task_id = Some(4);
        preparing.state = Some("checking".into());
        let mut merging = trow("task:5", "task");
        merging.task_id = Some(5);
        merging.state = Some("merging".into());
        let mut queued = trow("task:6", "task");
        queued.task_id = Some(6);
        queued.state = Some("review".into());
        queued.reason = Some("merge_queued");
        let mut inp = inputs(
            2,
            true,
            TodayView {
                watching: vec![d, handed, own, checking, preparing, merging, queued],
                ..TodayView::default()
            },
            vec![],
        );
        inp.facts = Facts::default();
        let v = merge(inp);
        invariants(&v);
        let at = |k: &str| {
            let (g, r) = find(&v, k);
            (g, r.stop, r.why.clone())
        };
        assert_eq!(at("dispatch:9"), ("running", Some(RowStop::Dispatch { id: 9 }), None));
        assert_eq!(at("task:1"), ("running", Some(RowStop::Dispatch { id: 11 }), None));
        assert_eq!(at("task:2"), ("running", Some(RowStop::Task { id: 2, run_seq: Some(4) }), None));
        assert_eq!(
            at("task:3"),
            ("running", Some(RowStop::Dispatch { id: 30 }), None),
            "the check's own work stops it"
        );
        assert_eq!(at("task:4"), ("watch", None, Some(RowWhy::CheckPreparing)));
        assert_eq!(at("task:5"), ("watch", None, Some(RowWhy::Merging)));
        assert_eq!(at("task:6"), ("watch", None, Some(RowWhy::MergeQueued)));
    }

    /// Work that just failed is under way while its assistant's turn has
    /// the news, watched until then.
    #[test]
    fn work_that_just_failed_waits_for_its_assistants_turn() {
        let failed = |id: i32| {
            let mut r = trow(&format!("failed:{id}"), "failed");
            r.dispatch_id = Some(id);
            r.reason = Some("looking");
            r
        };
        let mut facts = Facts::default();
        facts.looking.insert(1, Standing::InTurn { bot: 2, batch: 50 });
        facts.looking.insert(2, Standing::Queued { bot: 2 });
        let v = moving_view(vec![failed(1), failed(2)], vec![], facts);
        invariants(&v);
        let (g, r) = find(&v, "failed:1");
        assert_eq!((g, r.stop, r.why.clone()), ("running", Some(RowStop::Turn { bot: 2, batch: 50 }), Some(RowWhy::Looking { bot: 2 })));
        let (g, r) = find(&v, "failed:2");
        assert_eq!((g, r.stop, r.why.clone()), ("watch", None, Some(RowWhy::Looking { bot: 2 })));
    }

    fn watch_facts(id: i32, phase: &str) -> WatchFacts {
        WatchFacts {
            pr: RowPr {
                watch_id: id,
                number: 100 + i64::from(id),
                provider: "github".into(),
                url: None,
                head_sha: Some("abc".into()),
                is_mr: false,
            },
            dispatch_id: None,
            task_id: None,
            since: Utc::now(),
            phase: Some(phase.into()),
            fixing: None,
            fix_pending: false,
            health: WatchHealth::Fine,
        }
    }

    fn pr_row(id: i32, phase: &str) -> TodayRow {
        let mut r = trow(&format!("pr:{id}"), "pr");
        r.state = Some(phase.into());
        r
    }

    /// A watched pull request: watched while codeg goes on with it; the
    /// owner's when nobody fixes it; the fixing work's, or a card's, when
    /// one stands for it.
    #[test]
    fn a_pull_request_stands_where_its_fixing_is() {
        let mut facts = Facts::default();
        for (id, phase) in [(1, "checks_failed"), (2, "conflict"), (3, "checks_failed"), (4, "open"), (5, "waiting_checks"), (6, "checks_failed"), (7, "checks_failed")] {
            facts.watches.insert(id, watch_facts(id, phase));
        }
        facts.watches.get_mut(&3).unwrap().fix_pending = true;
        facts.watches.get_mut(&6).unwrap().fixing = Some(60);
        facts.watches.get_mut(&7).unwrap().fixing = Some(70);
        // The work fixing #6 is on the page; #7's is not.
        let mut fix = trow("dispatch:60", "dispatch");
        fix.dispatch_id = Some(60);
        let rows = (1..=7).map(|id| pr_row(id, "x")).chain([fix]).collect();
        let v = moving_view(rows, vec![], facts);
        invariants(&v);
        let at = |k: &str| {
            let (g, r) = find(&v, k);
            (g, r.why.clone())
        };
        assert_eq!(at("pr:1"), ("needs", Some(RowWhy::NobodyFixing { cause: "checks" })));
        assert_eq!(at("pr:2"), ("needs", Some(RowWhy::NobodyFixing { cause: "conflict" })));
        assert_eq!(at("pr:3"), ("watch", Some(RowWhy::FixPending)));
        assert_eq!(at("pr:4"), ("watch", Some(RowWhy::PlatformBlocked)));
        assert_eq!(at("pr:5"), ("watch", None));
        let (g, lead) = find(&v, "dispatch:60");
        assert_eq!((g, lead.why.clone()), ("running", Some(RowWhy::Fixing)));
        assert_eq!(lead.pr.as_ref().map(|p| p.watch_id), Some(6), "one row: the fixing work's");
        assert!(!all(&v).iter().any(|r| r.key == "pr:6"));
        let (g, r) = find(&v, "pr:7");
        assert_eq!((g, r.stop), ("running", Some(RowStop::Dispatch { id: 70 })));
        assert_eq!(r.pr.as_ref().map(|p| p.number), Some(107));

        // A card asking whether to fix it stands for it.
        let mut facts = Facts::default();
        facts.watches.insert(1, watch_facts(1, "checks_failed"));
        let mut card = trow("card:2:40", "confirm");
        card.watch_id = Some(1);
        let v = with(
            TodayView {
                needs: vec![card],
                watching: vec![pr_row(1, "checks_failed")],
                ..TodayView::default()
            },
            vec![],
            facts,
        );
        invariants(&v);
        assert_eq!(all(&v).len(), 1);
        let (g, r) = find(&v, "card:2:40");
        assert_eq!((g, r.pr.as_ref().map(|p| p.watch_id)), ("needs", Some(1)));
    }

    /// Work delivered to a pull request is one row, the pull request's —
    /// found by its work or by its board task — and not also done.
    #[test]
    fn delivered_work_is_its_pull_requests_row() {
        for by_task in [false, true] {
            let mut facts = Facts::default();
            let mut w = watch_facts(1, "waiting_checks");
            if by_task {
                w.task_id = Some(5);
            } else {
                w.dispatch_id = Some(7);
            }
            facts.watches.insert(1, w);
            let mut finished = trow("finished:7", "finished");
            finished.dispatch_id = Some(7);
            let mut item = item(3, Some(WaitsFor::External), Some(7));
            item.kind = ItemKind::Dispatch;
            let mut inp = inputs(
                2,
                false,
                TodayView {
                    watching: vec![pr_row(1, "waiting_checks")],
                    done: vec![finished],
                    ..TodayView::default()
                },
                vec![(item, 2)],
            );
            inp.item_tasks.insert(7, 5);
            inp.facts = facts;
            let v = merge(inp);
            invariants(&v);
            assert_eq!(all(&v).len(), 1, "by task {by_task}: {:#?}", v.groups);
            let (g, r) = find(&v, "pr:1");
            assert_eq!((g, r.thing.as_str()), ("watch", "item:3"));
            assert!(r.item.is_some());
        }
    }

    /// A routine's run that handed out work is that work's row; one with
    /// none stands as its assistant's turn has it.
    #[test]
    fn a_routine_run_is_its_works_or_its_turns() {
        let mut with_work = trow("routine_run:1", "routine_run");
        with_work.dispatch_id = Some(9);
        with_work.routine_id = Some(4);
        let mut work = trow("dispatch:9", "dispatch");
        work.dispatch_id = Some(9);
        let mut in_turn = trow("routine_run:2", "routine_run");
        in_turn.routine_id = Some(4);
        let mut queued = trow("routine_run:3", "routine_run");
        queued.routine_id = Some(4);
        let mut facts = Facts::default();
        facts.routine_runs.insert(2, Standing::InTurn { bot: 2, batch: 50 });
        facts.routine_runs.insert(3, Standing::Queued { bot: 2 });
        let v = moving_view(vec![with_work, work, in_turn, queued], vec![], facts);
        invariants(&v);
        let (g, lead) = find(&v, "dispatch:9");
        assert_eq!(g, "running");
        assert_eq!(lead.run.as_ref().map(|r| (r.run_id, r.routine_id)), Some((1, 4)));
        assert!(!all(&v).iter().any(|r| r.key == "routine_run:1"));
        let (g, r) = find(&v, "routine_run:2");
        assert_eq!((g, r.stop), ("running", Some(RowStop::Turn { bot: 2, batch: 50 })));
        let (g, r) = find(&v, "routine_run:3");
        assert_eq!((g, r.why.clone()), ("watch", Some(RowWhy::Queued { bot: 2 })));
    }

    /// A reminder handed to its assistant: watched while it waits for the
    /// turn, under way in it, the owner's again once that turn is over
    /// with it still open.
    #[test]
    fn a_handed_reminder_stands_as_its_turn_has_it() {
        for (standing, group, why) in [
            (Standing::Queued { bot: 2 }, "watch", Some(RowWhy::Queued { bot: 2 })),
            (Standing::InTurn { bot: 2, batch: 50 }, "running", Some(RowWhy::InTurn { bot: 2 })),
            (Standing::Ended, "needs", Some(RowWhy::Unfinished)),
        ] {
            let mut r = trow("reminder:1", "reminder");
            r.item_id = Some(1);
            r.state = Some("handed".into());
            let mut facts = Facts::default();
            facts.inputs.insert(1, standing);
            let v = moving_view(vec![r], vec![item(1, Some(WaitsFor::Agent), None)], facts);
            invariants(&v);
            let (g, row) = find(&v, "reminder:1");
            assert_eq!((g, row.why.clone()), (group, why), "{standing:?}");
        }
    }

    /// A message waiting on an answer: watched in its receiver's queue,
    /// under way in its turn, the owner's once that turn ended without an
    /// answer — unless the receiver's work for it is there, which it goes in.
    #[test]
    fn a_message_stands_as_its_receiver_has_it() {
        let message = || {
            let mut m = item(2, Some(WaitsFor::Agent), None);
            m.kind = ItemKind::Message;
            m.peer = Some(serde_json::json!({ "id": 3, "name": "Dev" }));
            m
        };
        for (standing, group, why) in [
            (Standing::Queued { bot: 3 }, "watch", Some(RowWhy::Queued { bot: 3 })),
            (Standing::InTurn { bot: 3, batch: 51 }, "running", Some(RowWhy::InTurn { bot: 3 })),
            (Standing::Ended, "needs", Some(RowWhy::NoReply { peer: 3 })),
        ] {
            let mut facts = Facts::default();
            facts.messages.insert(2, standing);
            let v = with(TodayView::default(), vec![message()], facts);
            invariants(&v);
            let (g, row) = find(&v, "item:2");
            assert_eq!((g, row.why.clone()), (group, why), "{standing:?}");
            if group == "running" {
                assert_eq!(row.stop, Some(RowStop::Turn { bot: 3, batch: 51 }));
            }
        }
        // Not answered, the receiver's work for it under way: in that row.
        let mut inp = message_and_work(Some("message:10"), None, 3);
        inp.facts.messages.insert(2, Standing::Ended);
        let v = merge(inp);
        invariants(&v);
        assert!(v.groups.needs.is_empty(), "{:#?}", v.groups.needs);
        assert_eq!(v.groups.running[0].folded[0].thing, "item:2");
    }

    /// A follow-up: the owner's when it says so, coming up with its time —
    /// or with none, nothing bringing it up — under way only in a turn.
    #[test]
    fn a_follow_up_is_coming_up_unless_someone_is_on_it() {
        let follow = |id: i32, waits: Option<WaitsFor>, due: bool| {
            let mut f = item(id, waits, None);
            f.kind = ItemKind::Followup;
            f.due_at = due.then(Utc::now);
            f
        };
        let mut facts = Facts::default();
        facts.inputs.insert(4, Standing::InTurn { bot: 2, batch: 50 });
        let v = with(
            TodayView::default(),
            vec![
                follow(1, Some(WaitsFor::Owner), false),
                follow(2, Some(WaitsFor::Agent), true),
                follow(3, Some(WaitsFor::External), false),
                follow(4, Some(WaitsFor::Agent), false),
            ],
            facts,
        );
        invariants(&v);
        assert_eq!(find(&v, "item:1").0, "needs");
        assert_eq!(find(&v, "item:2").0, "next");
        let (g, r) = find(&v, "item:3");
        assert_eq!((g, r.why.clone()), ("next", Some(RowWhy::NoTrigger)));
        let (g, r) = find(&v, "item:4");
        assert_eq!((g, r.stop), ("running", Some(RowStop::Turn { bot: 2, batch: 50 })));
    }

    /// Work that failed is the owner's, whatever its matter says it waits
    /// on.
    #[test]
    fn failed_work_with_no_row_of_its_own_is_the_owners() {
        let mut d = item(1, Some(WaitsFor::Agent), Some(9));
        d.kind = ItemKind::Dispatch;
        d.dispatch_state = Some(DispatchState::Failed);
        let v = with(TodayView::default(), vec![d], Facts::default());
        invariants(&v);
        let (g, r) = find(&v, "item:1");
        assert_eq!((g, r.why.clone()), ("needs", Some(RowWhy::Failed)));
    }

    /// The assistants' suggestions are the owner's, one line, not counted
    /// — by their kind, never their level: a pull request to review is not
    /// one.
    #[test]
    fn suggestions_are_set_apart_by_kind_and_not_counted() {
        let rule = |key: &str, rule: &str| {
            let mut r = trow(key, "rule");
            r.state = Some(rule.into());
            r
        };
        let mut approval = trow("card:2:1", "approval");
        approval.level = Some(crate::models::personal_agent_prefs::Level::Low);
        let today = TodayView {
            needs: vec![
                trow("proposal:1", "proposal"),
                trow("tidy:1", "tidy"),
                trow("skill:1", "skill"),
                rule("rule:1", "uncommitted"),
                rule("rule:2", "idle"),
                rule("rule:3", "pr_review"),
                approval,
            ],
            ..TodayView::default()
        };
        let v = with(today, vec![], Facts::default());
        invariants(&v);
        assert_eq!(v.groups.suggestions.len(), 5, "{:#?}", v.groups.suggestions);
        // What something is stuck on before what asks to decide.
        let needs: Vec<&str> = v.groups.needs.iter().map(|r| r.key.as_str()).collect();
        assert_eq!(needs, vec!["card:2:1", "rule:3"]);
        assert_eq!((v.groups.waiting, v.waiting), (2, 7));
        assert_eq!(v.groups.pill.first.as_deref(), Some("card:2:1"));
    }

    /// A check over, its verdict not taken in yet: nothing to stop — it is
    /// watched; so is work that can no longer be stopped.
    #[test]
    fn work_that_cannot_be_stopped_is_watched_not_under_way() {
        let mut checking = trow("task:3", "task");
        checking.task_id = Some(3);
        checking.state = Some("checking".into());
        checking.check_dispatch_id = Some(300);
        let mut d = trow("dispatch:301", "dispatch");
        d.dispatch_id = Some(301);
        let v = moving_view(vec![checking, d], vec![], Facts::default());
        invariants(&v);
        let (g, r) = find(&v, "task:3");
        assert_eq!((g, r.why.clone()), ("watch", Some(RowWhy::CheckSettling)));
        assert_eq!(find(&v, "dispatch:301").0, "watch");
    }

    /// Work delivered as a pull request whose board task still says review:
    /// one row, the pull request's.
    #[test]
    fn a_task_delivered_as_a_pull_request_is_its_pull_requests_row() {
        let mut facts = Facts::default();
        let mut w = watch_facts(1, "waiting_checks");
        w.dispatch_id = Some(7);
        w.task_id = Some(5);
        facts.watches.insert(1, w);
        let mut task = trow("task:5", "task");
        task.task_id = Some(5);
        task.work_dispatch_id = Some(7);
        task.state = Some("review".into());
        let mut item = item(3, Some(WaitsFor::External), Some(7));
        item.kind = ItemKind::Dispatch;
        let mut inp = inputs(
            2,
            false,
            TodayView {
                needs: vec![task],
                watching: vec![pr_row(1, "waiting_checks")],
                ..TodayView::default()
            },
            vec![(item, 2)],
        );
        inp.item_tasks.insert(7, 5);
        inp.facts = facts;
        let v = merge(inp);
        invariants(&v);
        assert_eq!(all(&v).len(), 1, "{:#?}", v.groups);
        assert_eq!(find(&v, "pr:1").1.thing, "item:3");
    }

    /// A routine's run whose work waits on the owner is that work's row;
    /// merged today is one row, not also "finished"; what happens on a
    /// piece of work is not the work.
    #[test]
    fn a_routine_run_merged_work_and_reports_are_each_once() {
        let mut run = trow("routine_run:1", "routine_run");
        run.dispatch_id = Some(9);
        run.routine_id = Some(4);
        let mut waiting = trow("waiting:2:9", "waiting");
        waiting.dispatch_id = Some(9);
        let mut finished = trow("finished:8", "finished");
        finished.dispatch_id = Some(8);
        let mut merged = trow("pr_merged:2", "pr_merged");
        merged.dispatch_id = Some(8);
        let mut report = trow("routine_report:6", "routine_report");
        report.dispatch_id = Some(10);
        let mut other = trow("finished:10", "finished");
        other.dispatch_id = Some(10);
        let v = with(
            TodayView {
                needs: vec![waiting],
                watching: vec![run],
                done: vec![finished, merged, report, other],
                ..TodayView::default()
            },
            vec![],
            Facts::default(),
        );
        invariants(&v);
        let (g, lead) = find(&v, "waiting:2:9");
        assert_eq!((g, lead.run.as_ref().map(|r| r.run_id)), ("needs", Some(1)));
        assert!(!all(&v).iter().any(|r| r.key == "routine_run:1"));
        let done: Vec<&str> = v.groups.done.iter().map(|r| r.key.as_str()).collect();
        assert_eq!(done, vec!["pr_merged:2", "routine_report:6", "finished:10"]);
    }

    /// A row waiting on the owner carries what ignoring it holds to; ignored
    /// as it stands, it is out of the list and its count — the same row
    /// moved on since shows again. Rows elsewhere have nothing to ignore.
    #[test]
    fn an_ignored_row_waiting_on_the_owner_is_left_out_until_it_moves() {
        // Each read the same rows, as they stood then.
        let t0 = Utc::now();
        let at = |key: &str, kind: &'static str| {
            let mut r = trow(key, kind);
            r.at = t0;
            r
        };
        let today = || TodayView {
            needs: vec![
                at("approval:1", "approval"),
                at("session:2", "session"),
                at("proposal:9", "proposal"),
            ],
            watching: vec![at("dispatch:3", "dispatch")],
            ..TodayView::default()
        };
        let v = with(today(), vec![], Facts::default());
        invariants(&v);
        let (_, row) = find(&v, "approval:1");
        let mark = row.dismiss.clone().expect("a row waiting on the owner");
        assert!(mark.starts_with(&format!("{}@", row.thing)), "{mark}");
        assert!(find(&v, "dispatch:3").1.dismiss.is_none());
        // A suggestion is ignored the same way.
        let (g, suggestion) = find(&v, "proposal:9");
        assert_eq!(g, "suggestions");
        let suggested = suggestion.dismiss.clone().expect("a suggestion");

        let mut inp = inputs(2, false, today(), vec![]);
        inp.dismissed.insert(mark.clone());
        inp.dismissed.insert(suggested);
        let v = merge(inp);
        invariants(&v);
        let keys: Vec<&str> = v.groups.needs.iter().map(|r| r.key.as_str()).collect();
        assert_eq!(keys, vec!["session:2"]);
        assert!(v.groups.suggestions.is_empty());
        assert_eq!((v.groups.waiting, v.waiting), (1, 1));

        // Moved on since: shown again.
        let mut moved = today();
        moved.needs[0].at += chrono::Duration::seconds(5);
        let mut inp = inputs(2, false, moved, vec![]);
        inp.dismissed.insert(mark);
        let v = merge(inp);
        invariants(&v);
        assert_eq!(find(&v, "approval:1").0, "needs");
    }

    /// A reminder ignored on the day it came due stays ignored once that day
    /// is over and it stands as its matter's own row — until the matter
    /// changes.
    #[test]
    fn an_ignored_reminder_is_the_same_mark_after_its_day() {
        let matter = item(5, Some(WaitsFor::Owner), None);
        let mut due = blank("reminder:5".into(), Some(2));
        due.thing = "item:5".into();
        due.today = Some(trow("reminder:5", "reminder"));
        due.item = Some(matter.clone());
        let mut after = blank("item:5".into(), Some(2));
        after.item = Some(matter.clone());
        assert_eq!(dismiss_mark(&due), dismiss_mark(&after));
        let mut changed = after.clone();
        changed.item.as_mut().unwrap().updated_at += chrono::Duration::seconds(1);
        assert_ne!(dismiss_mark(&after), dismiss_mark(&changed));
    }

    /// A message its receiver ended its turn on without an answer waits on
    /// the owner — never folded out of sight into work only watched now.
    #[test]
    fn a_message_without_an_answer_is_not_folded_into_watched_work() {
        let mut facts = Facts::default();
        let mut w = watch_facts(1, "waiting_checks");
        w.dispatch_id = Some(9);
        facts.watches.insert(1, w);
        let mut pr = pr_row(1, "waiting_checks");
        pr.bot_id = Some(3);
        pr.dispatch_id = Some(9);
        let mut message = item(2, Some(WaitsFor::Agent), None);
        message.kind = ItemKind::Message;
        let mut inp = inputs(1, true, TodayView { watching: vec![pr], ..TodayView::default() }, vec![(message, 1)]);
        inp.item_messages.insert(2, SentMessage { id: 10, thread: None, to_bot: 3 });
        inp.works.insert(9, WorkSource { bot: Some(3), for_input: Some("message:10".into()), thread: None });
        facts.messages.insert(2, Standing::Ended);
        inp.facts = facts;
        let v = merge(inp);
        invariants(&v);
        let (g, r) = find(&v, "item:2");
        assert_eq!((g, r.why.clone()), ("needs", Some(RowWhy::NoReply { peer: 0 })));
        assert!(find(&v, "pr:1").1.folded.is_empty());
    }

    /// A message taken up once and waiting again is watched, no longer to
    /// be taken back.
    #[test]
    fn a_message_waiting_again_is_redelivered() {
        let mut m = item(2, Some(WaitsFor::Agent), None);
        m.kind = ItemKind::Message;
        let mut facts = Facts::default();
        facts.messages.insert(2, Standing::Requeued { bot: 3 });
        let v = with(TodayView::default(), vec![m], facts);
        invariants(&v);
        let (g, r) = find(&v, "item:2");
        assert_eq!((g, r.why.clone()), ("watch", Some(RowWhy::Redelivering { bot: 3 })));
    }

    /// A pull request that can be merged stands as its card; a board task
    /// in review its work was delivered from is that card's row, found by
    /// the task too — but a later run of the task that failed is its own.
    #[test]
    fn a_mergeable_pull_requests_task_is_its_cards_row() {
        let mut facts = Facts::default();
        let mut w = watch_facts(1, "mergeable");
        w.task_id = Some(5);
        facts.watches.insert(1, w);
        let mut card = trow("card:2:40", "pr_ready");
        card.watch_id = Some(1);
        let mut review = trow("task:5", "task");
        review.task_id = Some(5);
        review.state = Some("review".into());
        let mut failed = trow("task:6", "task");
        failed.task_id = Some(5);
        failed.state = Some("failed".into());
        let v = with(TodayView { needs: vec![card, review.clone()], ..TodayView::default() }, vec![], facts.clone());
        invariants(&v);
        let keys: Vec<&str> = v.groups.needs.iter().map(|r| r.key.as_str()).collect();
        assert_eq!(keys, vec!["card:2:40"]);
        let v = with(TodayView { needs: vec![failed], ..TodayView::default() }, vec![], facts);
        assert_eq!(v.groups.needs.len(), 1, "a run of its own");
    }

    /// A message its receiver's turn is on keeps its [Stop]: it is not
    /// folded into work stopped another way.
    #[test]
    fn a_message_in_its_receivers_turn_keeps_its_stop() {
        let mut inp = message_and_work(Some("message:10"), None, 3);
        inp.facts.messages.insert(2, Standing::InTurn { bot: 3, batch: 51 });
        let v = merge(inp);
        invariants(&v);
        let (g, r) = find(&v, "item:2");
        assert_eq!((g, r.stop), ("running", Some(RowStop::Turn { bot: 3, batch: 51 })));
        assert!(v.groups.running.iter().all(|r| r.folded.is_empty()));
    }

    /// A follow-up come due today, handed to its assistant whose turn is
    /// over: a follow-up still — coming up, not "not finished".
    #[test]
    fn a_follow_up_come_due_today_stands_as_a_follow_up() {
        let mut r = trow("reminder:1", "reminder");
        r.item_id = Some(1);
        r.state = Some("handed".into());
        let mut f = item(1, Some(WaitsFor::Agent), None);
        f.kind = ItemKind::Followup;
        f.due_at = Some(Utc::now());
        let mut facts = Facts::default();
        facts.inputs.insert(1, Standing::Ended);
        let v = moving_view(vec![r], vec![f], facts);
        invariants(&v);
        assert_eq!(find(&v, "reminder:1").0, "next");
    }

    /// A later run of delivered work: its failure is that run's row's, the
    /// pull request's card keeping to the merge; a run begun after the
    /// delivery, in review again, is the owner's to look at again.
    #[test]
    fn a_later_run_of_delivered_work_is_its_own() {
        let mut facts = Facts::default();
        let mut w = watch_facts(1, "mergeable");
        w.dispatch_id = Some(7);
        w.task_id = Some(5);
        w.since = Utc::now() - chrono::Duration::hours(2);
        facts.watches.insert(1, w);
        let mut card = trow("card:2:40", "pr_ready");
        card.watch_id = Some(1);
        let mut failed = trow("failed:7", "failed");
        failed.dispatch_id = Some(7);
        let mut item = item(3, Some(WaitsFor::Agent), Some(7));
        item.kind = ItemKind::Dispatch;
        item.dispatch_state = Some(DispatchState::Failed);
        let v = with(TodayView { needs: vec![card.clone(), failed], ..TodayView::default() }, vec![item], facts.clone());
        invariants(&v);
        assert_eq!(find(&v, "failed:7").1.thing, "item:3", "its run's row");
        assert!(find(&v, "card:2:40").1.item.is_none());
        let mut review = trow("task:5", "task");
        review.task_id = Some(5);
        review.work_dispatch_id = Some(7);
        review.state = Some("review".into());
        review.run_started_at = Some(Utc::now() - chrono::Duration::minutes(5));
        let v = with(TodayView { needs: vec![card, review], ..TodayView::default() }, vec![], facts);
        assert_eq!(v.groups.needs.len(), 2, "sent back and run again since: {:#?}", v.groups.needs);
    }

    /// Work delivered whose watch stopped: nobody tells its merge — the
    /// owner's.
    #[test]
    fn delivered_work_no_watch_stands_for_is_the_owners() {
        let mut d = item(1, Some(WaitsFor::External), Some(9));
        d.kind = ItemKind::Dispatch;
        d.dispatch_state = Some(DispatchState::Completed);
        let v = with(TodayView::default(), vec![d], Facts::default());
        invariants(&v);
        assert_eq!(find(&v, "item:1").0, "needs");
    }

    /// A task asking for input and a question come due are what something
    /// is stuck on: before a confirmation that waited longer.
    #[test]
    fn what_blocks_comes_before_what_waits_longer() {
        let mut confirm = trow("card:2:1", "confirm");
        confirm.at = Utc::now() - chrono::Duration::hours(3);
        let mut asking = trow("task:4", "task");
        asking.task_id = Some(4);
        asking.state = Some("awaiting_input".into());
        let mut due = trow("reminder:5", "reminder");
        due.item_id = Some(5);
        let mut q = item(5, Some(WaitsFor::Owner), None);
        q.kind = ItemKind::Question;
        let v = with(TodayView { needs: vec![confirm, asking, due], ..TodayView::default() }, vec![q], Facts::default());
        invariants(&v);
        let keys: Vec<&str> = v.groups.needs.iter().map(|r| r.key.as_str()).collect();
        assert_eq!(keys.last(), Some(&"card:2:1"), "{keys:?}");
    }

    #[test]
    fn a_board_tasks_row_carries_the_task_as_it_read_it() {
        let at = Utc::now();
        let mut t = trow("task:5", "task");
        t.task_id = Some(5);
        t.run_seq = Some(2);
        t.task_updated_at = Some(at);
        t.work_dispatch_id = Some(9);
        let r = today_row(t, &Facts::default());
        assert_eq!(
            r.task,
            Some(RowTask { id: 5, run_seq: 2, updated_at: at, dispatch_id: Some(9) })
        );
        // Not a task's: none.
        let r = today_row(trow("dispatch:9", "dispatch"), &Facts::default());
        assert_eq!(r.task, None);
    }

    /// A pull request ready to merge whose card is gone: the owner's still,
    /// its row carrying the watch and head its merge needs.
    #[test]
    fn a_ready_pull_request_without_its_card_waits_on_the_owner() {
        let mut facts = Facts::default();
        facts.watches.insert(1, watch_facts(1, "mergeable"));
        let mut pr = trow("pr:1", "pr");
        pr.state = Some("mergeable".into());
        let v = moving_view(vec![pr], vec![], facts);
        invariants(&v);
        let (g, r) = find(&v, "pr:1");
        assert_eq!(g, "needs");
        assert_eq!(r.pr.as_ref().map(|p| p.watch_id), Some(1));
    }

    /// Failed work the owner handed to its assistant from the activity: its
    /// assistant's now — out of what waits on them, no button left to press.
    #[test]
    fn failed_work_the_owner_saw_to_is_its_assistants() {
        let mut f = trow("failed:7", "failed");
        f.dispatch_id = Some(7);
        f.reason = Some("failed");
        let mut facts = Facts::default();
        facts.handed.insert(7);
        let v = with(TodayView { needs: vec![f.clone()], ..TodayView::default() }, vec![], facts);
        invariants(&v);
        let (g, r) = find(&v, "failed:7");
        assert_eq!((g, r.why.clone()), ("watch", Some(RowWhy::Looking { bot: 2 })));
        let v = with(TodayView { needs: vec![f], ..TodayView::default() }, vec![], Facts::default());
        assert_eq!(find(&v, "failed:7").0, "needs", "not seen to: the owner's");
    }

    /// 6.6: a watched pull request not read, its checks or its review
    /// waited on too long — the owner's, saying why; a review waited on a
    /// while yet, watched saying it.
    #[test]
    fn a_watch_not_read_or_waiting_long_is_the_owners() {
        let at = |phase: &str, health: WatchHealth| {
            let mut facts = Facts::default();
            let mut w = watch_facts(1, phase);
            w.health = health;
            facts.watches.insert(1, w);
            let v = moving_view(vec![pr_row(1, phase)], vec![], facts);
            invariants(&v);
            let (g, r) = find(&v, "pr:1");
            (g, r.why.clone())
        };
        assert_eq!(
            at("checks_failed", WatchHealth::ReadFailed("auth".into())),
            ("needs", Some(RowWhy::ReadFailed { error: "auth".into() }))
        );
        assert_eq!(
            at("waiting_checks", WatchHealth::ChecksSlow(5)),
            ("needs", Some(RowWhy::ChecksSlow { hours: 5 }))
        );
        assert_eq!(at("waiting_checks", WatchHealth::Fine), ("watch", None));
        assert_eq!(
            at("open", WatchHealth::ReviewSlow(3)),
            ("needs", Some(RowWhy::ReviewSlow { days: 3 }))
        );
        assert_eq!(
            at("open", WatchHealth::ReviewPending),
            ("watch", Some(RowWhy::ReviewPending))
        );
        assert_eq!(at("open", WatchHealth::Fine), ("watch", Some(RowWhy::PlatformBlocked)));
    }

    /// A watched pull request's row moves only when a read finds a change:
    /// one ignored while its checks ran long shows again once it cannot be
    /// read — the same row, waiting on something else — but not because its
    /// checks have run another hour.
    #[test]
    fn an_ignored_pull_request_shows_again_when_it_waits_on_something_else() {
        let t0 = Utc::now();
        let view = |health: WatchHealth, dismissed: &[String]| {
            let mut facts = Facts::default();
            let mut w = watch_facts(1, "waiting_checks");
            w.health = health;
            facts.watches.insert(1, w);
            let mut row = pr_row(1, "waiting_checks");
            row.at = t0;
            let mut inp = inputs(
                2,
                false,
                TodayView {
                    watching: vec![row],
                    ..TodayView::default()
                },
                vec![],
            );
            inp.facts = facts;
            inp.dismissed = dismissed.iter().cloned().collect();
            let v = merge(inp);
            invariants(&v);
            v
        };
        let v = view(WatchHealth::ChecksSlow(5), &[]);
        let mark = find(&v, "pr:1")
            .1
            .dismiss
            .clone()
            .expect("waits on the owner");
        assert!(mark.ends_with("#checks_slow"), "{mark}");

        let ignored = [mark];
        let v = view(WatchHealth::ChecksSlow(6), &ignored);
        assert!(v.groups.needs.is_empty(), "another hour is not moving on");
        let v = view(WatchHealth::ReadFailed("auth".into()), &ignored);
        let (g, r) = find(&v, "pr:1");
        assert_eq!(g, "needs");
        let unread = r.dismiss.clone().expect("waits on the owner");
        assert!(unread.ends_with("#read_failed:auth"), "{unread}");

        // Ignored that way too, and read again with its checks still slow:
        // back where it was ignored first, it stays out of sight.
        let ignored = [ignored[0].clone(), unread];
        let v = view(WatchHealth::ReadFailed("auth".into()), &ignored);
        assert!(v.groups.needs.is_empty());
        let v = view(WatchHealth::ChecksSlow(7), &ignored);
        assert!(v.groups.needs.is_empty(), "its first mark is still kept");
    }
}
