//! Wire types for the token-usage dashboard.
//!
//! ## What "usage" means here
//!
//! One row of [`crate::db::entities::token_usage_turn`] is one *API call's*
//! usage as the agent's own transcript reported it. Summing them is the same
//! semantic `parsers::compute_session_stats` already uses for a single
//! conversation's total — input tokens legitimately repeat across turns
//! because every call re-sends the conversation prefix, and that repetition is
//! exactly what a spend dashboard is measuring.
//!
//! One nuance worth stating: for Codex, `SessionStats::total_usage` shown in
//! the conversation panel is the agent's own authoritative cumulative counter,
//! not the sum of turns. The dashboard always sums turns (it has to — a
//! session-level total cannot be placed on a time axis), so a Codex
//! conversation's dashboard total can differ slightly from the number its
//! detail panel prints.
//!
//! ## Time
//!
//! Facts are stored in UTC. Every bucket boundary (day / week / month / hour of
//! day / weekday) is computed in the *viewer's* local time, using the
//! `tz_offset_minutes` the client sends. A fixed offset is used for the whole
//! range rather than a real tz database: a DST transition inside the range
//! shifts one boundary by an hour, which is immaterial at this granularity and
//! keeps the aggregation a pure, testable function.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Bucket width of the time series.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TokenUsageBucket {
    #[default]
    Day,
    /// ISO weeks — Monday-start. Not configurable: every locale codeg ships
    /// either uses Monday or reads a Monday-start week without friction, and a
    /// switch would have to thread through the streak math too.
    Week,
    Month,
}

/// What the dashboard is asking for.
///
/// `None` on a dimension means "no constraint" — every value passes. An empty
/// `Vec` is NOT the same thing: it is an explicit selection of nothing, and
/// matches nothing. The frontend sends `null` (never `[]`) when a filter is
/// cleared, so the two never blur in practice; the distinction exists so a
/// caller that really means "nothing" can say so instead of silently getting
/// everything.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageFilter {
    /// Inclusive lower bound. `None` = from the first recorded turn.
    pub start: Option<DateTime<Utc>>,
    /// Exclusive upper bound. `None` = up to now.
    pub end: Option<DateTime<Utc>>,
    /// Selected project folders. Each id is expanded to include the folders
    /// whose `parent_id` points at it, so picking a project also counts the
    /// task worktrees created under it.
    pub folder_ids: Option<Vec<i32>>,
    /// `conversation.agent_type` wire strings (`"claude_code"`, `"custom:x"`).
    pub agent_types: Option<Vec<String>>,
    /// Exact model names as the transcripts reported them.
    pub models: Option<Vec<String>>,
    #[serde(default)]
    pub bucket: TokenUsageBucket,
    /// The viewer's offset from UTC in minutes (`-new Date().getTimezoneOffset()`).
    #[serde(default)]
    pub tz_offset_minutes: i32,
    /// Also compute totals for the equally-long window immediately before
    /// `start`, so the UI can show period-over-period deltas. Ignored when the
    /// range is open-ended on either side.
    #[serde(default)]
    pub compare_previous: bool,
}

/// The four raw counters plus everything derivable from a set of turns.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TokenUsageTotals {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub total_tokens: u64,
    pub turn_count: u64,
    /// In a served report this is the *workspace* session count for the window
    /// (see `workspace_conversation_count`), overwritten by the command layer
    /// so it reconciles with the status bar's counter. The fold itself fills
    /// in distinct fact conversations, which is what breakdown items and
    /// `previous_totals` keep.
    pub conversation_count: u64,
    /// Summed generation time of the counted turns — not wall-clock time spent
    /// in the app.
    pub duration_ms: u64,
    /// Distinct local calendar days with at least one counted turn.
    pub active_days: u32,
}

/// One point of the time series. `bucket_key` is a stable local-time label the
/// frontend formats for display; `start`/`end` are the real UTC bounds so a
/// tooltip can render the exact span.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsagePoint {
    /// `YYYY-MM-DD` for day and week buckets (the bucket's first local day),
    /// `YYYY-MM` for month buckets.
    pub bucket_key: String,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub total_tokens: u64,
    pub turn_count: u64,
    pub conversation_count: u64,
}

/// One slice of a categorical breakdown (folder / agent / model).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsageBreakdownItem {
    /// Stable identity for color assignment and filter round-trips: the folder
    /// id as a string, the agent wire name, or the model name.
    pub key: String,
    /// Display name resolved server-side (folder alias/name; model and agent
    /// keys are their own label).
    pub label: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub total_tokens: u64,
    pub turn_count: u64,
    pub conversation_count: u64,
}

/// One cell of the weekday × hour activity grid. Only non-empty cells are sent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsageHeatCell {
    /// 0 = Monday … 6 = Sunday, in local time.
    pub weekday: u8,
    /// 0–23, local time.
    pub hour: u8,
    pub total_tokens: u64,
    pub turn_count: u64,
}

/// A single conversation's contribution, for the "biggest sessions" list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsageConversationItem {
    pub conversation_id: i32,
    pub title: Option<String>,
    pub agent_type: String,
    pub folder_label: Option<String>,
    pub total_tokens: u64,
    pub output_tokens: u64,
    pub turn_count: u64,
    /// Summed recorded generation time of the counted turns.
    pub duration_ms: u64,
    pub last_activity_at: DateTime<Utc>,
}

/// Consecutive-active-day runs over local calendar days inside the range.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TokenUsageStreak {
    /// Longest run of consecutive active days anywhere in the range.
    pub longest_days: u32,
    /// Run ending on the range's last active day — only meaningful when that
    /// day is today or yesterday, which the frontend decides.
    pub current_days: u32,
    /// Local date (`YYYY-MM-DD`) the current run ends on.
    pub current_ends_on: Option<String>,
}

/// Everything one dashboard render needs, from one query.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsageReport {
    /// The range actually applied after resolving open bounds — what the share
    /// card prints.
    pub range_start: Option<DateTime<Utc>>,
    pub range_end: Option<DateTime<Utc>>,
    pub bucket: TokenUsageBucket,
    pub totals: TokenUsageTotals,
    /// Totals for the equally-long window before `range_start`. `None` unless
    /// `compare_previous` was set and both bounds resolved.
    pub previous_totals: Option<TokenUsageTotals>,
    /// Dense: buckets with no activity inside the range are present with zeros,
    /// so the chart's x-axis has no invisible gaps.
    pub series: Vec<TokenUsagePoint>,
    pub by_folder: Vec<TokenUsageBreakdownItem>,
    pub by_agent: Vec<TokenUsageBreakdownItem>,
    pub by_model: Vec<TokenUsageBreakdownItem>,
    pub heatmap: Vec<TokenUsageHeatCell>,
    pub top_conversations: Vec<TokenUsageConversationItem>,
    pub streak: TokenUsageStreak,
    pub first_activity_at: Option<DateTime<Utc>>,
    pub last_activity_at: Option<DateTime<Utc>>,
    /// True when the query hit [`crate::commands::token_usage::MAX_SCANNED_FACTS`]
    /// and the numbers are a prefix of the real range rather than all of it.
    pub truncated: bool,
}

/// A folder that has at least one recorded turn.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsageFolderFacet {
    pub folder_id: i32,
    /// Compact display name — the alias when one is set, else the folder name.
    /// Kept for callers that only have room for one string; the filter list
    /// renders `alias [ name ]` from the two fields below instead, so an
    /// aliased folder never hides which directory it actually is.
    pub label: String,
    /// The folder's real (on-disk) directory name, alias or not.
    pub name: String,
    /// The user-set display alias, or `None` when unset.
    pub alias: Option<String>,
    pub path: String,
    /// Set when this folder is a worktree created under another folder — the
    /// UI nests it so picking the parent visibly covers it.
    pub parent_id: Option<i32>,
}

/// The dimension values that actually occur in the stored facts, so the filter
/// controls never offer an option that yields an empty chart.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsageFacets {
    pub folders: Vec<TokenUsageFolderFacet>,
    /// Agent wire names, ordered by recorded tokens descending.
    pub agents: Vec<String>,
    /// Model names, ordered by recorded tokens descending.
    pub models: Vec<String>,
    pub data_start: Option<DateTime<Utc>>,
    pub data_end: Option<DateTime<Utc>>,
}

/// How current the materialized facts are.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsageSyncStatus {
    /// Live (non-deleted) conversations that can carry usage.
    pub total_conversations: u64,
    /// Of those, how many have been parsed at least once.
    pub synced_conversations: u64,
    /// Of those, how many changed since their last parse (includes the
    /// never-parsed).
    pub stale_conversations: u64,
    pub fact_rows: u64,
    pub last_synced_at: Option<DateTime<Utc>>,
    /// A sync is running right now (this process).
    pub running: bool,
}

/// Outcome of one sync pass.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TokenUsageSyncResult {
    pub scanned: u32,
    /// Conversations re-parsed and rewritten.
    pub synced: u32,
    /// Conversations skipped because nothing changed since the last pass.
    pub skipped: u32,
    /// Conversations that hit a real fault — a transcript that would not parse,
    /// a write that errored. Their previous facts are left untouched and the
    /// next pass retries them. This is the only counter the UI treats as bad
    /// news, so it must never carry a state the user cannot act on.
    pub failed: u32,
    /// Conversations whose transcript is gone. Their recorded facts are kept
    /// exactly as they were and their stamp is settled, so a source that can
    /// never be re-derived stops being re-attempted (and re-reported) on every
    /// pass. Not a failure: nothing was lost that was not already lost on disk.
    pub lost: u32,
    pub turns_written: u64,
    pub tokens_written: u64,
    /// Fact rows dropped because their conversation no longer exists.
    pub pruned_conversations: u32,
}

/// Progress ticks emitted while a sync runs.
#[derive(Debug, Clone, Serialize)]
pub struct TokenUsageSyncProgress {
    pub done: u32,
    pub total: u32,
    /// Title of the conversation just finished — a human-readable "what is it
    /// doing" line, absent for untitled sessions.
    pub current_title: Option<String>,
    /// Set on the final tick; absent while running.
    pub result: Option<TokenUsageSyncResult>,
}
