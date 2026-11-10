//! The roster (4.14, 10.1) and each assistant's live state (8.3), as the
//! page reads them: `personal_agent_bots` once, then `personal-agent://bots`
//! as they change.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::personal_agent::BotSummary;
use crate::db::entities::personal_agent_dispatch::{DispatchMode, DispatchState};

/// Pushed on the live state of one assistant, or that the roster itself
/// changed (one made, deleted, pinned, hidden…) and is to be read again.
pub const PERSONAL_AGENT_BOTS_EVENT: &str = "personal-agent://bots";

/// How the owner arranged an assistant on the roster.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RosterFlags {
    pub sort_order: i32,
    pub pinned_at: Option<DateTime<Utc>>,
    pub section: Option<String>,
    pub hidden: bool,
    pub muted: bool,
    pub unread_mark: bool,
    pub notify: bool,
}

/// What the owner does to an assistant on the roster.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "act", rename_all = "snake_case")]
pub enum RosterAct {
    Pin,
    Unpin,
    /// Into a group of the owner's (`None`: out of any).
    Section {
        name: Option<String>,
    },
    Hide,
    Show,
    Mute,
    Unmute,
    MarkUnread,
    /// Opened: the owner's unread mark goes.
    MarkRead,
    /// The order of the pinned ones, top first.
    Order {
        ids: Vec<i32>,
    },
    Notify {
        on: bool,
    },
}

/// Whether it works now (8.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkState {
    /// Its brain runs a turn, or work it handed out runs.
    Busy,
    /// Nothing runs, but something it has is not done.
    Idle,
    /// Nothing runs and all it had is done.
    Done,
}

/// What it wants of the owner (8.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Attention {
    /// A card in its conversation waits for the owner's answer.
    NeedsYou,
    /// Something it said the owner has not seen (or marked unread).
    Unread,
    None,
}

/// The face it shows (10.6). `Stuck` is the page's own: waiting on the
/// owner past two minutes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FaceState {
    Idle,
    Thinking,
    Working,
    Waiting,
    Done,
    Failed,
    Sleeping,
}

/// A face shown for a few seconds.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct FaceFlash {
    pub face: FaceState,
    pub until: DateTime<Utc>,
}

/// The first of what waits on the owner, and how many there are.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NeedsYou {
    /// `question` | `permission` | `plan` | `confirm` | `uncertain` | `loop`
    /// | `choice` | `changed` | `input` (handed-out work asks).
    pub kind: String,
    /// The question, the card's title, the work's title.
    pub text: String,
    pub since: DateTime<Utc>,
    /// The timeline row of the card, to scroll to.
    pub row_id: Option<i32>,
    pub count: u32,
    /// A copy of another assistant's question or permission request, shown
    /// where what it is for began (4.11): the same request as the asker's.
    #[serde(skip)]
    pub mirror: bool,
    /// The handed-out work that asks (`input`).
    #[serde(skip)]
    pub dispatch_id: Option<i32>,
}

/// One step, as the page says it in a short line (8.4). The same shape says
/// what is being done (`status` in progress) and what was done.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StepLine {
    pub n: u32,
    /// `think` | `reply` | `plan` | `compact` | `question` | `read` | `edit`
    /// | `search` | `fetch` | `execute` | `test` | `commit` | `dispatch` |
    /// `followup` | `message` | `other`.
    pub kind: String,
    /// The file's name, the query, the command, the executor config or
    /// assistant, the commit message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// `pending` | `in_progress` | `completed` | `failed`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// Waiting on the owner: a permission, a question, a plan approval.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub awaiting: bool,
    pub started_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub passed: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hits: Option<u32>,
    /// A dispatch the step made or followed up.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dispatch_id: Option<i32>,
}

/// Handed-out work an activity is from.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ActivityWork {
    pub dispatch_id: i32,
    pub title: String,
}

/// What it is doing now: its brain's step, or — its brain at rest — the
/// latest step of the work it handed out.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Activity {
    pub step: StepLine,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work: Option<ActivityWork>,
    /// The brain's turn (its batch), which picks the wording that rotates.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn: Option<i32>,
}

/// A piece of its work still moving.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct HandWork {
    pub dispatch_id: i32,
    pub title: String,
    pub mode: DispatchMode,
    pub state: DispatchState,
    pub work_task_id: Option<i32>,
    pub conversation_id: Option<i32>,
    /// Where it stands on the PR ladder (8.5).
    pub ladder: super::personal_agent_overview::Ladder,
}

/// A message of its another assistant has not answered yet.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AwaitedReply {
    pub message_id: i32,
    pub to_bot_id: i32,
    pub to_name: String,
}

/// The last thing it said.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LastLine {
    pub text: String,
    pub at: DateTime<Utc>,
}

/// One assistant's live state (8.3), computed by codeg from what it knows —
/// never by a model.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BotLive {
    pub bot_id: i32,
    pub work: WorkState,
    pub attention: Attention,
    pub needs: Option<NeedsYou>,
    /// Its replies and result cards the owner has not seen.
    pub unread: u32,
    pub activity: Option<Activity>,
    /// Whether this process can tell the activity at all (one that does not
    /// run the assistants reads the database only).
    pub activity_known: bool,
    pub work_on_hand: Vec<HandWork>,
    pub awaiting: Vec<AwaitedReply>,
    /// Its face at rest from the rest of the state.
    pub face: FaceState,
    /// A turn or a piece of work just done (or failed): shown on its face
    /// over `face` till then.
    pub flash: Option<FaceFlash>,
    /// Its brain's connection is up.
    pub connected: bool,
    pub last_line: Option<LastLine>,
    /// When anything last happened in its conversation: the order within a
    /// tier of the roster.
    pub last_activity_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
    /// A busy state not renewed by then is stale: the page shows it at rest
    /// (8.3; principle 14).
    pub expires_at: Option<DateTime<Utc>>,
}

/// One assistant on the roster.
#[derive(Debug, Clone, Serialize)]
pub struct RosterEntry {
    #[serde(flatten)]
    pub bot: BotSummary,
    pub roster: RosterFlags,
    pub live: BotLive,
}

/// Payload of [`PERSONAL_AGENT_BOTS_EVENT`].
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BotsChange {
    Live { bot_id: i32, live: Box<BotLive> },
    Roster,
}
