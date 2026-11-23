//! Where a piece of handed-out work stands, as codeg reads it from the
//! dispatch and the kanban task behind it (8.5): the PR ladder, and the
//! facts a task card shows.

use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::db::entities::work_task::WorkTaskStatus;

/// A rung of the PR ladder (8.5): what codeg knows of the work, and of
/// its pull request as the watch reads it (7.4). Code-changing work is finished at `merged`; work that
/// only writes a report is finished at `done`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Ladder {
    /// To do, queued, setting up or running.
    Working,
    /// Waiting on the owner: an answer, an approval.
    WaitingYou,
    /// Ready for review and being accepted: checked by another executor,
    /// or waiting on its assistant's conclusion (7.5).
    Checking,
    /// Waiting for the owner's review and merge — or, when its assistant
    /// accepts it, accepted.
    Mergeable,
    /// The board is landing it.
    Merging,
    /// Delivered as a pull request, open: not watched, or watched with
    /// nothing more to say (its checks green but the forge will not merge it
    /// yet, say).
    PrOpen,
    /// A watched pull request whose head's checks are still running (7.4).
    WaitingChecks,
    /// A watched pull request whose head's checks failed.
    ChecksFailed,
    /// A watched pull request that cannot be merged as it is: a conflict.
    Stuck,
    /// A watched pull request closed without being merged.
    PrClosed,
    Merged,
    /// Ended without a merge: a report, a conversation's work, a task the
    /// owner accepted without merging.
    Done,
    Failed,
    /// Set aside on the board for later.
    Paused,
    Canceled,
    /// The owner took it over in its conversation.
    HandedOver,
}

impl Ladder {
    /// Still moving (or waiting) rather than settled.
    pub fn is_live(self) -> bool {
        matches!(
            self,
            Ladder::Working
                | Ladder::WaitingYou
                | Ladder::Checking
                | Ladder::Mergeable
                | Ladder::Merging
        )
    }

    /// In a sentence for a model: "ready to merge", "PR opened".
    pub fn phrase(self) -> &'static str {
        match self {
            Ladder::Working => "working",
            Ladder::WaitingYou => "waiting for the owner",
            Ladder::Checking => "in review, being checked and accepted",
            Ladder::Mergeable => "ready to merge (in review)",
            Ladder::Merging => "merging",
            Ladder::PrOpen => "PR opened, not merged yet",
            Ladder::WaitingChecks => "PR opened, its checks running",
            Ladder::ChecksFailed => "PR opened, its checks failed",
            Ladder::Stuck => "PR opened, stuck: it conflicts with its base",
            Ladder::PrClosed => "PR closed without merging",
            Ladder::Merged => "merged",
            Ladder::Done => "done",
            Ladder::Failed => "failed",
            Ladder::Paused => "set aside for later",
            Ladder::Canceled => "canceled",
            Ladder::HandedOver => "taken over by the owner",
        }
    }
}

/// A watched pull request as the task card shows it (7.4, 8.5).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PrFacts {
    pub watch_id: i32,
    /// Where it stands: `waiting_checks` | `checks_failed` | `conflict` |
    /// `mergeable` | `no_conflict` | `open` | `merged` | `closed`; `None`
    /// before its first read.
    pub phase: Option<String>,
    /// Its head's checks: passed, failed (that may not fail), running, of
    /// how many; `checks_known` is false where the forge shows none (CNB).
    pub passed: u32,
    pub failed: u32,
    pub pending: u32,
    pub total: u32,
    pub checks_known: bool,
    /// The head the checks are of, shortened.
    pub head: Option<String>,
    pub merge_state: Option<String>,
    pub last_read_at: Option<DateTime<Utc>>,
    /// What was last read may be out of date: read longer ago than two of
    /// its intervals, or held back by a rate limit or a failing forge.
    pub stale: bool,
    /// Still being read (not ended).
    pub watching: bool,
}

/// The kanban task behind a task dispatch, as its card shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TaskFacts {
    pub task_id: i32,
    pub status: WorkTaskStatus,
    /// The project the task belongs to.
    pub folder_id: i32,
    pub branch: Option<String>,
    pub base_branch: Option<String>,
    pub files_changed: Option<i32>,
    pub additions: Option<i32>,
    pub deletions: Option<i32>,
    /// The pull request its latest delivery reached.
    pub pr_url: Option<String>,
    pub pr_number: Option<i64>,
    /// How a `done` task ended: `merged` | `delivered_pr` |
    /// `accepted_without_merge`.
    pub completion_kind: Option<String>,
    pub conversation_id: Option<i32>,
    /// The connection of its live round, while it has one.
    pub connection_id: Option<String>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    /// Its pull request as the watch last read it.
    pub pr: Option<PrFacts>,
    /// What the board's next step for it is, in review — as "today" words
    /// it (`today::task_reason`: `merge_ready`, `needs_delivery`,
    /// `accepted_queued`, …): what its work's head offers (A4). Where it is
    /// read with its acceptance.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<&'static str>,
}
