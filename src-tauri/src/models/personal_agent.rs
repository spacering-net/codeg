//! The personal agent as the UI and its own engine see it.
//!
//! One long-lived assistant per data dir: the owner talks to it on its own
//! page, it hands work to the role assistants of 协作 → 助手 (as a kanban task,
//! a chat conversation, or a work conversation in a project's checkout), and it
//! keeps one continuous timeline across the agent sessions ("segments") it
//! runs on underneath.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::agent::AgentType;
use super::assistant::{AssistantAgentConfig, AssistantAvatar, AssistantLabelSnapshot};
use super::system::AppLocale;
use crate::acp::delegation::types::AgentDelegationDefaults;
use crate::db::entities::personal_agent_batch::BatchKind;
use crate::db::entities::personal_agent_dispatch::{DispatchMode, DispatchState};
use crate::db::entities::personal_agent_item::{ItemKind, ItemStatus, WaitsFor};
use crate::db::entities::personal_agent_segment::SegmentReason;
use crate::db::entities::personal_agent_timeline::{OwnerStatus, TimelineKind};

/// The default auto-compaction threshold. Unlike the kanban's (off by
/// default), the personal agent's session is in use all the time, so without
/// compaction it fills up for certain.
pub const DEFAULT_AUTO_COMPACT_PERCENT: i32 = 50;
/// The default size budget of a handoff card, in characters.
pub const DEFAULT_HANDOFF_BUDGET_CHARS: u32 = 32_000;
/// The default number of dispatched conversations running at once.
pub const DEFAULT_DISPATCH_CONCURRENCY: u32 = 3;

fn default_auto_compact_percent() -> i32 {
    DEFAULT_AUTO_COMPACT_PERCENT
}

fn default_handoff_budget() -> u32 {
    DEFAULT_HANDOFF_BUDGET_CHARS
}

fn default_dispatch_concurrency() -> u32 {
    DEFAULT_DISPATCH_CONCURRENCY
}

fn default_true() -> bool {
    true
}

/// An assistant's own settings, stored as JSON on its row. Every field
/// defaults, so a row written by an older build still reads.
///
/// `locale` is the account's, not the assistant's: it lives on the primary's
/// row only (see [`AccountSettings`]); a worker reads the primary's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersonalAgentSettings {
    /// Context occupancy, in percent, at or above which codeg compacts the
    /// session before the next delivery. `0` turns it off (the agent's own
    /// compaction is all that is left).
    #[serde(default = "default_auto_compact_percent")]
    pub auto_compact_percent: i32,
    /// The compact command, sent verbatim; `None` resolves it the way the
    /// kanban does (the session's advertised command, then a known default).
    #[serde(default)]
    pub compact_command: Option<String>,
    /// The agent type `compact_command` was written for. A command means
    /// something only to the agent it was written for, so switching the brain
    /// to another agent type clears it.
    #[serde(default)]
    pub compact_command_agent: Option<String>,
    /// Size budget of a handoff card, in characters.
    #[serde(default = "default_handoff_budget")]
    pub handoff_budget_chars: u32,
    /// Dispatched conversations (chat and session modes) running at once;
    /// `0` is no limit. Kanban tasks follow the board's own limit.
    #[serde(default = "default_dispatch_concurrency")]
    pub dispatch_concurrency: u32,
    /// Whether the built-in skill that teaches the agent its conventions is
    /// installed into the working directory.
    #[serde(default = "default_true")]
    pub skill_enabled: bool,
    /// The language of the UI the owner last saved these settings from — no
    /// field of the dialog: codeg keeps it so that what it writes for the
    /// owner without a request from the UI (the template files of a working
    /// directory made anew at the next session) is in their language.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locale: Option<AppLocale>,
}

impl Default for PersonalAgentSettings {
    fn default() -> Self {
        Self {
            auto_compact_percent: DEFAULT_AUTO_COMPACT_PERCENT,
            compact_command: None,
            compact_command_agent: None,
            handoff_budget_chars: DEFAULT_HANDOFF_BUDGET_CHARS,
            dispatch_concurrency: DEFAULT_DISPATCH_CONCURRENCY,
            skill_enabled: true,
            locale: None,
        }
    }
}

/// The keys of the settings JSON that are the account's — the same for every
/// assistant, kept on the primary's row only: the owner's language now, and
/// the preferences and the team's division of work as they come.
pub const ACCOUNT_KEYS: &[&str] = &["locale", "prefs", "team"];

/// The account's settings, as far as they are read in the engine: on the
/// primary's row, next to its own.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locale: Option<AppLocale>,
}

impl AccountSettings {
    pub fn parse(raw: &str) -> Self {
        serde_json::from_str(raw).unwrap_or_default()
    }
}

/// The settings JSON to store on an assistant's row: `own` for its own keys,
/// over what the row has. On the primary's row (`primary`), the account's
/// keys `own` does not speak for — those another part of codeg keeps — stay
/// as they are; a worker's row keeps none of them.
pub fn merge_settings_json(existing: &str, own: &PersonalAgentSettings, primary: bool) -> String {
    let mut map = match serde_json::from_str::<serde_json::Value>(existing) {
        Ok(serde_json::Value::Object(m)) => m,
        _ => serde_json::Map::new(),
    };
    let written = match serde_json::to_value(own) {
        Ok(serde_json::Value::Object(m)) => m,
        _ => serde_json::Map::new(),
    };
    // Its own keys are what `own` says — one it leaves out (an unset locale)
    // is gone.
    let own_keys = [
        "auto_compact_percent",
        "compact_command",
        "compact_command_agent",
        "handoff_budget_chars",
        "dispatch_concurrency",
        "skill_enabled",
        "locale",
    ];
    for k in own_keys {
        map.remove(k);
    }
    for (k, v) in written {
        map.insert(k, v);
    }
    if !primary {
        for k in ACCOUNT_KEYS {
            map.remove(*k);
        }
    }
    serde_json::Value::Object(map).to_string()
}

impl PersonalAgentSettings {
    /// The explicit compact command, but only for the agent it was written for.
    pub fn compact_command_for(&self, agent_type: AgentType) -> Option<&str> {
        let command = self
            .compact_command
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty())?;
        match self.compact_command_agent.as_deref() {
            Some(agent) if agent != agent_type.as_wire().as_ref() => None,
            _ => Some(command),
        }
    }

    /// Clamp what a client sent into range.
    pub fn normalized(mut self) -> Self {
        self.auto_compact_percent = self.auto_compact_percent.clamp(0, 100);
        self.compact_command = self
            .compact_command
            .map(|c| c.trim().to_string())
            .filter(|c| !c.is_empty());
        if self.compact_command.is_none() {
            self.compact_command_agent = None;
        }
        self.handoff_budget_chars = self.handoff_budget_chars.clamp(4_000, 200_000);
        self.dispatch_concurrency = self.dispatch_concurrency.min(64);
        self
    }
}

/// The personal agent's configuration, read back.
#[derive(Debug, Clone, Serialize)]
pub struct PersonalAgentInfo {
    pub id: i32,
    /// Empty means "use the localized default name".
    pub name: String,
    pub avatar: AssistantAvatar,
    pub agent_type: AgentType,
    pub agent_options: AgentDelegationDefaults,
    pub label_snapshot: AssistantLabelSnapshot,
    pub settings: PersonalAgentSettings,
    /// The working directory in effect.
    pub workdir: String,
    /// Whether the owner picked it (otherwise it is the data dir's default).
    pub workdir_custom: bool,
    pub folder_id: Option<i32>,
    pub revision: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// The primary assistant, or a worker.
    pub kind: crate::db::entities::personal_agent::BotKind,
    pub uid: Option<String>,
    /// The template a worker was made from.
    pub template: Option<String>,
    /// The executor profile a worker is bound to.
    pub executor_assistant_id: Option<i32>,
}

/// What the settings dialog saves. Absent fields stay as they are; the first
/// save must carry an agent config.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct PersonalAgentDraft {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub avatar: Option<AssistantAvatar>,
    #[serde(default)]
    pub agent_config: Option<AssistantAgentConfig>,
    #[serde(default)]
    pub settings: Option<PersonalAgentSettings>,
    /// The UI locale the dialog saves from (`zh-CN`, `ja`…): the language of
    /// the template files written into a new working directory, remembered
    /// in the settings (`PersonalAgentSettings::locale`).
    #[serde(default)]
    pub locale: Option<String>,
}

/// One timeline row.
#[derive(Debug, Clone, Serialize)]
pub struct TimelineRow {
    pub id: i32,
    pub segment_id: Option<i32>,
    pub batch_id: Option<i32>,
    pub kind: TimelineKind,
    pub status: Option<OwnerStatus>,
    pub body: String,
    pub data: Option<serde_json::Value>,
    pub dispatch_id: Option<i32>,
    pub ref_id: Option<String>,
    /// The row this one quotes.
    pub reply_to: Option<i32>,
    /// When the assistant started on it (owner messages and result cards);
    /// `None` is unread.
    pub read_at: Option<DateTime<Utc>>,
    /// The event a result card stands for.
    pub event_id: Option<i32>,
    /// When the owner saw it (an assistant reply once it settled, a result
    /// card); `None` is new to the owner.
    pub seen_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// One page of the timeline, newest last.
#[derive(Debug, Clone, Serialize)]
pub struct TimelinePage {
    pub rows: Vec<TimelineRow>,
    /// Whether rows older than the first one exist.
    pub has_older: bool,
    /// A range read (`since_id`) spans more rows than it may return: none
    /// are returned.
    pub too_far: bool,
}

/// Where a read of changed rows goes on from: past this `(updated_at, id)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimelineCursor {
    pub updated_at: DateTime<Utc>,
    pub id: i32,
}

/// Rows changed since a moment, in `(updated_at, id)` order.
#[derive(Debug, Clone, Serialize)]
pub struct TimelineChanges {
    pub rows: Vec<TimelineRow>,
    /// More changed than one read returns: read on from here.
    pub next: Option<TimelineCursor>,
}

/// The step the reply in flight is on, for the page that draws it.
#[derive(Debug, Clone, Serialize)]
pub struct LiveReply {
    pub row_id: i32,
    pub current: Option<crate::acp::reply_turn::ReplyStep>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SegmentInfo {
    pub id: i32,
    pub seq: i32,
    pub agent_type: AgentType,
    /// The agent's display name and option labels when the segment started.
    pub label_snapshot: AssistantLabelSnapshot,
    pub conversation_id: Option<i32>,
    pub agent_session_id: Option<String>,
    pub start_reason: SegmentReason,
    pub end_reason: Option<SegmentReason>,
    /// A switch waiting for the next delivery.
    pub pending_reason: Option<SegmentReason>,
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
    pub handoff_size: Option<i32>,
    /// Whether the last handoff card had to be cut to fit its budget.
    pub handoff_trimmed: bool,
    pub compactions_auto: i32,
    pub compactions_manual: i32,
    pub compactions_agent: i32,
    pub auto_compact_paused: bool,
}

/// What the executor of a dispatch was, frozen when it was dispatched.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DispatchExecutorSnapshot {
    pub assistant_id: i32,
    pub name: String,
    pub agent_type: AgentType,
    #[serde(default)]
    pub agent_options: AgentDelegationDefaults,
    #[serde(default)]
    pub label_snapshot: Option<AssistantLabelSnapshot>,
    #[serde(default)]
    pub instructions: String,
}

/// One message of a thread between assistants, as the exchange sheet shows
/// it.
#[derive(Debug, Clone, Serialize)]
pub struct ThreadMessage {
    pub id: i32,
    pub from_bot_id: i32,
    pub to_bot_id: i32,
    pub body: String,
    pub reply_to: Option<i32>,
    pub wants_reply: bool,
    pub state: crate::db::entities::personal_agent_message::MessageState,
    pub created_at: DateTime<Utc>,
}

/// A dispatch made on a thread, as the exchange sheet links it.
#[derive(Debug, Clone, Serialize)]
pub struct ThreadDispatch {
    pub id: i32,
    pub bot_id: Option<i32>,
    pub title: String,
    pub mode: DispatchMode,
    pub state: DispatchState,
    pub work_task_id: Option<i32>,
    pub conversation_id: Option<i32>,
    pub created_at: DateTime<Utc>,
}

/// A thread between assistants: every message on it, the assistants on it,
/// and the work handed out on it.
#[derive(Debug, Clone, Serialize)]
pub struct ThreadView {
    pub id: i32,
    pub state: crate::db::entities::personal_agent_thread::ThreadState,
    pub messages: Vec<ThreadMessage>,
    /// `{ id, name, avatar, kind }` of each assistant on it.
    pub bots: Vec<serde_json::Value>,
    pub dispatches: Vec<ThreadDispatch>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DispatchInfo {
    pub id: i32,
    pub mode: DispatchMode,
    pub executor: DispatchExecutorSnapshot,
    pub folder_id: Option<i32>,
    pub folder_name: Option<String>,
    pub deliverable: Option<String>,
    pub title: String,
    pub prompt: String,
    pub work_task_id: Option<i32>,
    pub conversation_id: Option<i32>,
    /// The folder the conversation sits in — a chat dispatch's own hidden
    /// chat folder, a session dispatch's project.
    pub conversation_folder_id: Option<i32>,
    /// The connection a chat or session dispatch's conversation runs on while
    /// it does, so a viewer can follow it live.
    pub connection_id: Option<String>,
    pub state: DispatchState,
    pub result_excerpt: Option<String>,
    pub error: Option<String>,
    pub on_done: Option<String>,
    pub turns: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ItemInfo {
    pub id: i32,
    pub kind: ItemKind,
    pub dispatch_id: Option<i32>,
    pub status: ItemStatus,
    pub waits_for: Option<WaitsFor>,
    pub summary: String,
    pub on_done: Option<String>,
    pub origin_timeline_id: Option<i32>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// The dispatch's state, for a dispatch item.
    pub dispatch_state: Option<DispatchState>,
}

/// A context-occupancy reading.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct UsageReading {
    pub percent: f64,
    pub used: Option<u64>,
    pub size: Option<u64>,
    /// `live` (the connection's own report) or `transcript`.
    pub source: &'static str,
}

/// What the last pre-delivery check decided, for the status panel. Skips are
/// shown only here — writing each one to the timeline would leave a row on
/// every delivery.
#[derive(Debug, Clone, Serialize)]
pub struct CompactCheck {
    pub at: DateTime<Utc>,
    /// `below` | `compacted` | `disabled` | `usage_unknown` | `no_command` |
    /// `paused` | `skipped_after_attempt`
    pub outcome: &'static str,
    pub percent: Option<f64>,
}

/// The latest compaction of the open segment, for the status panel.
#[derive(Debug, Clone, Serialize)]
pub struct LastCompaction {
    pub at: DateTime<Utc>,
    /// `auto` | `owner`.
    pub initiator: Option<String>,
    /// `ok` | `failed` | `canceled` | `running`.
    pub status: String,
    pub before_percent: Option<f64>,
    pub after_percent: Option<f64>,
}

/// Who started a compaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactInitiator {
    /// codeg, because the threshold was reached (or the context overflowed).
    Auto,
    /// The owner's compact button.
    Owner,
    /// The agent compacted on its own, inside a turn.
    Agent,
}

/// The turn in flight on the personal agent's connection.
#[derive(Debug, Clone, Serialize)]
pub struct TurnInfo {
    pub batch_id: i32,
    pub kind: BatchKind,
    pub started_at: DateTime<Utc>,
    pub compaction_initiator: Option<CompactInitiator>,
}

/// Where the engine runs, as seen from this process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineHost {
    /// In this process: the page is fully usable.
    Here,
    /// In another codeg process on the same data dir: the page is read-only.
    Elsewhere,
}

#[derive(Debug, Clone, Serialize)]
pub struct PersonalAgentStatus {
    pub engine: EngineHost,
    pub configured: bool,
    pub segment: Option<SegmentInfo>,
    pub connection_id: Option<String>,
    pub connected: bool,
    pub turn: Option<TurnInfo>,
    pub usage: Option<UsageReading>,
    pub auto_compact_percent: i32,
    /// The command a compaction would send now; `None` when none is known.
    pub compact_command: Option<String>,
    pub last_check: Option<CompactCheck>,
    pub last_compaction: Option<LastCompaction>,
    pub queued_messages: u32,
    pub pending_events: u32,
    /// The assistants' messages the owner has not seen yet (settled replies
    /// and result cards).
    pub unseen: u32,
    pub dispatch_running: u32,
    pub dispatch_queued: u32,
    pub dispatch_limit: u32,
    pub pending_permission: bool,
    pub pending_question: bool,
    pub last_error: Option<String>,
    pub workdir: Option<String>,
    /// The reply being written, so a page opened mid-turn draws it at once.
    pub live_reply: Option<LiveReply>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PersonalAgentSnapshot {
    pub agent: Option<PersonalAgentInfo>,
    pub status: PersonalAgentStatus,
}

/// One of the persona/memory files of the working directory.
#[derive(Debug, Clone, Serialize)]
pub struct PersonalAgentFile {
    pub name: String,
    pub content: String,
    pub exists: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct PersonalAgentDayStat {
    /// `YYYY-MM-DD`, local time.
    pub date: String,
    pub owner_messages: u32,
    pub replies: u32,
    pub dispatches_task: u32,
    pub dispatches_chat: u32,
    pub dispatches_session: u32,
    pub dispatches_completed: u32,
    pub dispatches_failed: u32,
    /// Tokens spent that day by the personal agent's own sessions.
    pub agent_tokens: i64,
    /// Tokens spent that day by the work it dispatched.
    pub dispatch_tokens: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PersonalAgentExecutorStat {
    pub assistant_id: i32,
    pub name: String,
    pub dispatches: u32,
    pub completed: u32,
}

/// One point of the context-usage curve: a reading taken before a delivery,
/// or the two ends of a compaction.
#[derive(Debug, Clone, Serialize)]
pub struct PersonalAgentUsagePoint {
    pub at: DateTime<Utc>,
    pub percent: f64,
    /// `delivery` | `compaction_before` | `compaction_after` | `segment_start`
    pub kind: String,
    pub segment_seq: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct PersonalAgentStats {
    pub days: Vec<PersonalAgentDayStat>,
    pub executors: Vec<PersonalAgentExecutorStat>,
    pub usage: Vec<PersonalAgentUsagePoint>,
    /// When the token figures were last synced from the agents' transcripts.
    pub tokens_synced_at: Option<DateTime<Utc>>,
}

/// Payload of `personal-agent://changed`. Timeline rows ride along whole, so
/// an open page appends them without a refetch, and so does the step the
/// reply in flight is on; everything else is a nudge to refetch.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PersonalAgentChange {
    Timeline { rows: Vec<TimelineRow> },
    /// The step reply row `row_id` is on now — whole, so a lost one is
    /// made good by the next.
    Reply {
        row_id: i32,
        current: Option<crate::acp::reply_turn::ReplyStep>,
    },
    Status,
    Agent,
    Dispatch { id: i32 },
    Item { id: i32 },
}
