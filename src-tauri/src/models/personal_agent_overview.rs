//! Where a piece of handed-out work stands, as codeg reads it from the
//! dispatch and the kanban task behind it (8.5): the PR ladder, and the
//! facts a task card shows.

use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::db::entities::work_task::WorkTaskStatus;

/// A rung of the PR ladder (8.5), phase 1: the rungs codeg knows without
/// following a PR. Code-changing work is finished at `merged`; work that
/// only writes a report is finished at `done`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Ladder {
    /// To do, queued, setting up or running.
    Working,
    /// Waiting on the owner: an answer, an approval.
    WaitingYou,
    /// Waiting for the owner's review and merge (no automatic acceptance in
    /// phase 1: a task in review can be merged).
    Mergeable,
    /// The board is landing it.
    Merging,
    /// Delivered as a pull request; codeg does not follow its status yet.
    PrOpen,
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
            Ladder::Working | Ladder::WaitingYou | Ladder::Mergeable | Ladder::Merging
        )
    }

    /// In a sentence for a model: "ready to merge", "PR opened".
    pub fn phrase(self) -> &'static str {
        match self {
            Ladder::Working => "working",
            Ladder::WaitingYou => "waiting for the owner",
            Ladder::Mergeable => "ready to merge (in review)",
            Ladder::Merging => "merging",
            Ladder::PrOpen => "PR opened, not merged yet (codeg does not follow PR status yet)",
            Ladder::Merged => "merged",
            Ladder::Done => "done",
            Ladder::Failed => "failed",
            Ladder::Paused => "set aside for later",
            Ladder::Canceled => "canceled",
            Ladder::HandedOver => "taken over by the owner",
        }
    }
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
}
