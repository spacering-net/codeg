import { parseTimestamp } from "@/components/conversations/sidebar-conversation-grouping"
import type { WorkTask, WorkTaskStatus } from "@/lib/types"
import { isDeferred } from "./task-acceptance"

/** The four board columns (DB statuses are exact; the UI aggregates them). */
export type BoardColumnId = "todo" | "inProgress" | "attention" | "done"

export const BOARD_COLUMN_IDS: BoardColumnId[] = [
  "todo",
  "inProgress",
  "attention",
  "done",
]

/**
 * The exact statuses behind each column, written out as a table.
 * `columnForStatus` stays the single source of truth for the mapping; this is
 * its spec copy, and board-columns.test.ts asserts the two agree and that every
 * `WorkTaskStatus` appears here exactly once — which is what makes adding a
 * status without filing it in a column a test failure rather than a silent
 * disappearance from the board.
 *
 * One overlay sits on top of it, applied per TASK by `columnForTask`: a review
 * or failed task the user put aside to handle later is filed under Done. Its
 * status is unchanged — the overlay is the whole of "以后处理".
 */
export const STATUSES_BY_COLUMN: Record<BoardColumnId, WorkTaskStatus[]> = {
  todo: ["todo", "queued"],
  inProgress: ["preparing", "running"],
  attention: ["awaiting_input", "review", "merging", "failed"],
  done: ["done", "canceled"],
}

/** Every status, column order — the flattened spec table (see above). */
export const ALL_WORK_TASK_STATUSES: WorkTaskStatus[] =
  BOARD_COLUMN_IDS.flatMap((col) => STATUSES_BY_COLUMN[col])

/**
 * DB status → board column. `canceled` lives in the Done column but is hidden
 * unless the "show canceled" toggle is on (filtered by `groupTasksByColumn`).
 */
export function columnForStatus(status: WorkTaskStatus): BoardColumnId {
  switch (status) {
    case "todo":
    // Still waiting for a concurrency slot — nothing is happening yet.
    case "queued":
      return "todo"
    // Already out of the queue and working (worktree, init command, agent
    // spawn), just without a session to show yet.
    case "preparing":
    case "running":
      return "inProgress"
    case "awaiting_input":
    case "review":
    // A merge is an agent turn, but the card must not bounce across the
    // board when the user clicks merge — it stays in the review column and
    // moves straight to Done when the merge lands.
    case "merging":
    case "failed":
      return "attention"
    case "done":
    case "canceled":
      return "done"
  }
}

/**
 * The column a TASK is filed in: its status's column (`columnForStatus`), except
 * for a task put aside to handle later, which waits under Done until the user
 * picks it back up (`isDeferred`). The board and the list's column filter both
 * read this, so a deferred task is in the same bucket in both views.
 */
export function columnForTask(task: WorkTask): BoardColumnId {
  return isDeferred(task) ? "done" : columnForStatus(task.status)
}

/**
 * Bucket tasks into the four columns. Canceled tasks are dropped unless
 * `showCanceled`, archived ones unless `showArchived` (archived is always
 * terminal).
 *
 * Every column reads freshest-first: `updated_at` descending, so whatever just
 * moved sits at the top of its column. The sort is stable and the backend hands
 * rows over in board order (sort_order, id), so equal timestamps keep that
 * order — which is exactly what preserves a pending-column drag: `reorder`
 * stamps the whole column with one `updated_at`, the rows tie, and the fallback
 * is their freshly written sort_order. sort_order still drives the launch queue
 * (`next_queued` / "start all"); it just no longer drives the display.
 */
export function groupTasksByColumn(
  tasks: WorkTask[],
  showCanceled: boolean,
  showArchived = false
): Record<BoardColumnId, WorkTask[]> {
  const grouped: Record<BoardColumnId, WorkTask[]> = {
    todo: [],
    inProgress: [],
    attention: [],
    done: [],
  }
  for (const task of tasks) {
    if (task.status === "canceled" && !showCanceled) continue
    if (task.archived_at != null && !showArchived) continue
    grouped[columnForTask(task)].push(task)
  }
  for (const column of BOARD_COLUMN_IDS) {
    grouped[column].sort(byFreshest)
  }
  return grouped
}

/** Freshest-first, the order every board column and the list view read in. */
function byFreshest(a: WorkTask, b: WorkTask): number {
  return parseTimestamp(b.updated_at) - parseTimestamp(a.updated_at)
}

/**
 * The list view's rows: one flat, freshest-first sequence instead of four
 * columns. `group` is the list-only status filter — a whole board COLUMN rather
 * than individual statuses (`null` = every status, which is the default), so
 * the list narrows by the same four buckets the board sorts into and the two
 * views can't describe the same tasks with different words.
 *
 * The visibility toggles apply exactly as they do on the board: `showCanceled`
 * and `showArchived` are one pair of controls shared by both views. (They have
 * to be: a column-wide filter cannot single out `canceled`, which lives inside
 * the Done column.)
 */
export function filterTasksForList(
  tasks: WorkTask[],
  group: BoardColumnId | null,
  showCanceled: boolean,
  showArchived: boolean
): WorkTask[] {
  return tasks
    .filter(
      (task) =>
        (task.status !== "canceled" || showCanceled) &&
        (task.archived_at == null || showArchived) &&
        (group == null || columnForTask(task) === group)
    )
    .sort(byFreshest)
}
