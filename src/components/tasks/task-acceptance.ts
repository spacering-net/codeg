import type { WorkTask, WorkTaskStatus } from "@/lib/types"

/**
 * The statuses a task can be put aside in ("以后处理") — mirror of the backend's
 * `DEFERRABLE_STATUSES`: settled and waiting on the user, with nothing running
 * that a deferral would leave hanging out of sight. `awaiting_input` waits on
 * the user too, but its agent is live and holds a slot (it is answered or
 * canceled, not parked), and `merging` is in flight.
 */
const DEFERRABLE_STATUSES: ReadonlySet<WorkTaskStatus> = new Set([
  "review",
  "failed",
])

/**
 * Whether the user put this task aside to handle later. Such a task waits under
 * Done instead of "needs you" and leaves the attention badge — but nothing
 * else about it changed: it is still a reviewed (or failed) task, and its
 * follow-up / retry / merge picks it back up and clears the mark.
 *
 * Read off the status as well as the mark. The backend clears the mark on
 * every way out of review / failed, so the two always agree — and if they ever
 * did not, a stale mark must not pull a running task off "In progress".
 */
export function isDeferred(task: WorkTask): boolean {
  return task.deferred_at != null && DEFERRABLE_STATUSES.has(task.status)
}

/**
 * Whether "以后处理" is on offer — the same conditions the backend's
 * `set_deferred` enforces: a reviewed or failed task not already put aside,
 * not archived (that already put it away), and not waiting in its project's
 * merge queue (an acceptance already made; its decision left is leaving the
 * queue, not when to look at the task).
 */
export function canDefer(task: WorkTask): boolean {
  return (
    DEFERRABLE_STATUSES.has(task.status) &&
    task.deferred_at == null &&
    task.archived_at == null &&
    task.merge_queued == null
  )
}

/**
 * Whether the task's worktree is gone: it ran in one (every generation does),
 * but the worktree was since removed — detached entirely, or its folder /
 * directory no longer exists (`worktree_missing`, stamped by the backend).
 * A merge generation cannot run without the worktree, so a reviewed task in
 * this state completes instead.
 */
export function isWorktreeGone(task: WorkTask): boolean {
  return task.worktree_folder_id == null || task.worktree_missing === true
}

/**
 * Whether the task HAD a worktree that has since been deleted — the card badge
 * predicate, distinct from `isWorktreeGone` in exactly one way: a just-created
 * task that never initialized (no worktree ever minted) is not "removed", it
 * simply hasn't started. `work_branch` is the witness that a worktree once
 * existed: it is recorded together with the worktree and survives the detach
 * that clears the folder pointer.
 */
export function worktreeWasRemoved(task: WorkTask): boolean {
  const hadWorktree =
    task.work_branch != null || task.worktree_folder_id != null
  return hadWorktree && isWorktreeGone(task)
}

/**
 * Whether the drawer should offer to remove the worktree on its own — a task
 * that STOPPED still sitting on the checkout it ran in. Every way of stopping
 * offers to take the worktree along and every one of them lets the user say no
 * (the acceptances' checkbox, the cancel dialog's), so a settled task can keep
 * a checkout nobody will open again; this is how that disk is reclaimed without
 * deleting the task itself.
 *
 * Two statuses qualify, for the same reason from opposite ends: `done` (the
 * work landed, or there was none) and `canceled` (the work was abandoned). A
 * canceled task can still be requeued, which is why the removal stays an
 * explicit, separate gesture here rather than something the cancel does on its
 * own — but leaving it unofferable meant the only way to reclaim that disk was
 * to delete the task, losing the record of why it was stopped.
 *
 * Two exclusions, both about not offering the same call twice:
 * - a worktree already gone (`isWorktreeGone`) has nothing to remove — the card
 *   says so with its own badge, and a button contradicting it would only
 *   confuse;
 * - a cleanup that FAILED already shows its retry entry in the same bar. Same
 *   backend call, and that one names the failure.
 */
export function canRemoveWorktree(task: WorkTask): boolean {
  return (
    (task.status === "done" || task.status === "canceled") &&
    !isWorktreeGone(task) &&
    task.cleanup_state !== "failed"
  )
}

/**
 * Whether a reviewed task has no merge to offer, so "complete" takes the
 * primary slot instead:
 * - the run produced nothing — only `0` counts; `null` means the engine could
 *   not read the stats, and merging stays the safe default there. The engine
 *   re-runs the same diff before it finishes the task, so a stale card cannot
 *   drop work. `files_changed` counts what the TASK wrote, measured from the
 *   commit its worktree was checked out at — which is not always the diff the
 *   drawer lists: a task triggered from a pull request is checked out ON that
 *   pull request, and its files are the material under review, not this task's
 *   work (a review-only task must offer "complete", not a delivery that would
 *   push nothing);
 * - or the worktree is gone (see `isWorktreeGone`) — a merge could only fail,
 *   and completing is the one acceptance left. The engine preserves a work
 *   branch that still holds unlanded commits.
 */
export function hasNothingToMerge(task: WorkTask): boolean {
  if (task.status !== "review") return false
  return task.files_changed === 0 || isWorktreeGone(task)
}

/**
 * Whether this task is waiting its turn in its project's merge queue — the user
 * accepted it while another task of the same project was landing. It stays in
 * review until the engine's merge pump dispatches it, so the queue mark is what
 * tells that row apart from one nobody has decided on yet.
 */
export function isMergeQueued(task: WorkTask): boolean {
  return task.status === "review" && task.merge_queued != null
}

/**
 * Whether a merge of this task's project is running right now — ANOTHER task's,
 * never `task`'s own. Merges are serial per project (one base branch, one
 * landing at a time), so this is what turns the merge button's "merge" into
 * "queue".
 *
 * Excluding the subject is the whole point, not a detail: the engine flips
 * review→merging and BROADCASTS it before the dispatch call returns (launching
 * the merge session takes seconds), so a plain "is any task of this folder
 * merging" goes true for the very task the user just accepted. That is a lie
 * with a nasty shape — for the width of their own dispatch it tells them the
 * project is busy with some other task and that their merge went into a queue.
 */
export function isAnotherTaskMerging(
  tasks: WorkTask[],
  task: WorkTask
): boolean {
  return tasks.some(
    (t) =>
      t.id !== task.id &&
      t.folder_id === task.folder_id &&
      t.status === "merging"
  )
}

/**
 * Place in line (1-based) for every queued task, per project — the order the
 * engine's pump will actually dispatch them in: oldest request first, task id
 * breaking a tie, exactly as `drain_merge_queue` sorts. A task that is not
 * queued has no entry.
 */
export function mergeQueueRanks(tasks: WorkTask[]): Map<number, number> {
  const byFolder = new Map<number, WorkTask[]>()
  for (const task of tasks) {
    if (!isMergeQueued(task)) continue
    const bucket = byFolder.get(task.folder_id)
    if (bucket) bucket.push(task)
    else byFolder.set(task.folder_id, [task])
  }
  const ranks = new Map<number, number>()
  // Compared as instants, not as strings: the backend writes RFC 3339 with a
  // variable number of fractional digits, and "…:00Z" sorts AFTER "…:00.5Z"
  // lexicographically.
  const at = (task: WorkTask): number => {
    const ms = Date.parse(task.merge_queued?.queued_at ?? "")
    return Number.isNaN(ms) ? 0 : ms
  }
  for (const bucket of byFolder.values()) {
    bucket.sort((a, b) => at(a) - at(b) || a.id - b.id)
    bucket.forEach((task, i) => ranks.set(task.id, i + 1))
  }
  return ranks
}

/**
 * Whether a reviewed task can be DELIVERED to the forge — as a new pull
 * request for an issue-sourced task, or back onto its own branch for a
 * pull-request-sourced one. Three conditions, and the backend re-checks every
 * one of them; this predicate only decides whether to offer the button.
 * - it came from a forge issue or pull request (a plain local task has no
 *   repository to push to);
 * - it has something to land — GitHub answers an empty pull request with a
 *   422, and `hasNothingToMerge` is the same test the merge button uses;
 * - its worktree is still there (folded into `hasNothingToMerge`).
 */
export function canDeliverToPr(task: WorkTask): boolean {
  return (
    task.status === "review" &&
    (task.source_kind === "forge_issue" || task.source_kind === "forge_pr") &&
    !hasNothingToMerge(task)
  )
}

/**
 * Whether this task's work belongs on the pull request it came from rather
 * than on the local base branch. The backend REFUSES a local merge for these
 * (landing it here would take the pull request's changes in behind its author's
 * back, leaving the review open and apparently unmerged), so the board must
 * not offer one — delivering back is the acceptance.
 */
export function mustDeliverToPr(task: WorkTask): boolean {
  return task.source_kind === "forge_pr"
}

/**
 * Whether this task's forge calls a proposed change a MERGE request. Only the
 * wording of the acceptance depends on it — a button that promises a pull
 * request and then opens a merge request reads like the wrong tool answered.
 * Tasks with no forge provenance (and rows stored before GitLab support) are
 * GitHub's, which is what they have always been.
 */
export function usesMergeRequests(task: WorkTask | null | undefined): boolean {
  return task?.source_meta?.provider === "gitlab"
}

/** The pull request a delivered task ended up in, if that is how it finished. */
export function deliveredPrUrl(task: WorkTask): string | null {
  if (task.completion_kind !== "delivered_pr") return null
  return task.source_meta?.result_pr ?? null
}
