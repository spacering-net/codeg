use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// Lifecycle of a work task. The pipeline is
/// `todo → queued → preparing → running ⇄ awaiting_input → review → merging →
/// done`, with `failed` / `canceled` as side paths. Two hard invariants:
/// - `done` ⟺ an ACCEPTED final success, and it never rolls back. Three ways
///   in — the merge landing (or its crash recovery), a delivery to a pull
///   request, and an explicit acceptance with nothing to land — each recording
///   which one it was in `completion_kind`. All three pass through `review`
///   first: nothing reaches `done` unseen.
/// - Every transition is a conditional UPDATE (CAS) guarded by the expected
///   status (and, for engine-driven transitions, the current `run_seq`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum WorkTaskStatus {
    #[sea_orm(string_value = "todo")]
    Todo,
    /// Claimed for execution; waiting for a concurrency slot.
    #[sea_orm(string_value = "queued")]
    Queued,
    /// Out of the queue and setting up: worktree creation, the folder's init
    /// command, then spawning the agent CLI. No agent turn has started yet —
    /// the task holds a slot, can be canceled, and a restart treats it as
    /// interrupted exactly like `queued`.
    #[sea_orm(string_value = "preparing")]
    Preparing,
    #[sea_orm(string_value = "running")]
    Running,
    /// The agent is blocked on a question / permission / plan approval.
    #[sea_orm(string_value = "awaiting_input")]
    AwaitingInput,
    /// Agent finished; waiting for the user to accept (merge), return, or drop.
    #[sea_orm(string_value = "review")]
    Review,
    /// Merge in flight — the only state the user cannot cancel.
    #[sea_orm(string_value = "merging")]
    Merging,
    #[sea_orm(string_value = "done")]
    Done,
    #[sea_orm(string_value = "failed")]
    Failed,
    /// Not a dead end: requeue moves it back to `todo` (worktree reused).
    #[sea_orm(string_value = "canceled")]
    Canceled,
}

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "work_task")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    /// The project folder (never a worktree folder). Soft reference; every
    /// query joins the live folder.
    pub folder_id: i32,
    pub title: String,
    /// JSON `WorkTaskConfig` — per-task overrides; empty fields inherit the
    /// folder's `work_task_settings`.
    #[sea_orm(column_type = "Text")]
    pub config: String,
    pub status: WorkTaskStatus,
    /// agent_error | setup_error | verdict_blocked | interrupted
    pub failure_reason: Option<String>,
    pub last_error: Option<String>,
    /// Execution generation: bumped whenever a new run is claimed
    /// (start / retry / return). Events match on (connection_id, run_seq);
    /// anything stale is dropped.
    pub run_seq: i32,
    pub sort_order: i32,
    pub worktree_folder_id: Option<i32>,
    pub conversation_id: Option<i32>,
    /// Live ACP connection of the current generation. Not durable across
    /// restart (a fresh process has no live connections).
    pub connection_id: Option<String>,
    pub base_branch: Option<String>,
    /// The exact commit the worktree branched from — recorded BEFORE the
    /// worktree is created so a concurrent branch switch can't drift it.
    pub base_sha: Option<String>,
    pub work_branch: Option<String>,
    /// JSON `WorkTaskMergeState` — the merge intent persisted in the same
    /// transaction as the review→merging CAS; crash recovery reads git truth
    /// against it.
    #[sea_orm(column_type = "Text")]
    pub merge_state: Option<String>,
    /// JSON `WorkTaskQueuedMerge` — a merge the user asked for while the
    /// folder's one merge slot was busy. Written by `queue_merge`, consumed by
    /// the folder's merge pump (and by `begin_merge`, whichever dispatch wins);
    /// cleared by every user-driven claim / cancel / failure, so a task that
    /// leaves review never carries a stale intent.
    #[sea_orm(column_type = "Text")]
    pub pending_merge: Option<String>,
    /// NULL = nothing pending; 'failed' = worktree cleanup failed (retryable).
    pub cleanup_state: Option<String>,
    /// success | needs_review | blocked (P1, agent self-report via MCP).
    pub verdict: Option<String>,
    pub result_summary: Option<String>,
    pub files_changed: Option<i32>,
    pub additions: Option<i32>,
    pub deletions: Option<i32>,
    pub merge_commit: Option<String>,
    /// How this task reached `done`: 'merged' | 'delivered_pr' |
    /// 'accepted_without_merge'. NULL on every non-done row, and on done rows
    /// that predate the column. Written in the same transaction as the status,
    /// so a `done` row never carries an unexplained ending.
    pub completion_kind: Option<String>,
    /// JSON `WorkTaskPreflight` — result of the folder's preflight command run
    /// when this generation settled into review (P2 acceptance light).
    #[sea_orm(column_type = "Text")]
    pub preflight: Option<String>,
    /// Archived (hidden from the default board view); terminal statuses only.
    /// Cleared by any resurrection (retry / requeue / return).
    pub archived_at: Option<DateTimeUtc>,
    /// Planned start of a `todo` task; NULL = no plan. The scheduler claims the
    /// row and clears this column in the SAME transaction, so a plan fires
    /// exactly once — and every explicit claim clears it too, because a task
    /// that already started has no start left to plan.
    pub scheduled_at: Option<DateTimeUtc>,
    /// The user put this settled task aside ("handle later"): the board files
    /// it under Done instead of "needs you", and it stops counting toward the
    /// attention badge, until they pick it back up. NULL = not put aside.
    ///
    /// Only ever set on a `review` / `failed` row, and NOT a status of its own:
    /// the task stays exactly as resumable as it was (a follow-up or a retry
    /// starts a new run from here), so its review or failure remains the truth
    /// about it. Every transition out of those two statuses clears it, so a
    /// task that comes back from another run always lands in "needs you"
    /// again — and the unattended merge refuses a row carrying it.
    pub deferred_at: Option<DateTimeUtc>,
    /// Forge provenance: 'forge_issue' | 'forge_pr'; NULL = not forge-sourced.
    /// Set once at creation by the forge trigger command, never by the public
    /// create/update DTO paths, and never mutated afterwards.
    pub source_kind: Option<String>,
    /// Canonical lookup/dedup key (`forge::source_key` output). Queried — the
    /// one exception to `config`'s "never queried" rule, which is exactly why
    /// it is a column and not part of `config`.
    pub source_key: Option<String>,
    /// JSON snapshot of the source (URL, title, account id, PR head/base …).
    /// Same discipline as `config`: replayed/displayed, never queried.
    #[sea_orm(column_type = "Text")]
    pub source_meta: Option<String>,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
    pub started_at: Option<DateTimeUtc>,
    /// Entered review / failed.
    pub settled_at: Option<DateTimeUtc>,
    /// Entered done / canceled.
    pub finished_at: Option<DateTimeUtc>,
    pub deleted_at: Option<DateTimeUtc>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(has_many = "super::work_task_event::Entity")]
    Events,
    #[sea_orm(
        belongs_to = "super::folder::Entity",
        from = "Column::FolderId",
        to = "super::folder::Column::Id"
    )]
    Folder,
}

impl Related<super::work_task_event::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Events.def()
    }
}

impl Related<super::folder::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Folder.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
