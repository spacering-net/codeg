import { describe, expect, it } from "vitest"
import {
  ALL_WORK_TASK_STATUSES,
  BOARD_COLUMN_IDS,
  columnForStatus,
  columnForTask,
  filterTasksForList,
  groupTasksByColumn,
  STATUSES_BY_COLUMN,
  type BoardColumnId,
} from "./board-columns"
import { TASKS_STATUS_GROUPS } from "@/lib/tasks-board-filter-storage"
import type { WorkTask, WorkTaskStatus } from "@/lib/types"

function task(
  id: number,
  status: WorkTaskStatus,
  extra?: Partial<WorkTask>
): WorkTask {
  return {
    id,
    folder_id: 1,
    title: `t${id}`,
    config: null,
    status,
    failure_reason: null,
    last_error: null,
    run_seq: 0,
    sort_order: id,
    worktree_folder_id: null,
    conversation_id: null,
    connection_id: null,
    base_branch: null,
    base_sha: null,
    work_branch: null,
    cleanup_state: null,
    verdict: null,
    result_summary: null,
    files_changed: null,
    additions: null,
    deletions: null,
    merge_commit: null,
    preflight: null,
    archived_at: null,
    scheduled_at: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    started_at: null,
    settled_at: null,
    finished_at: null,
    ...extra,
  }
}

describe("columnForStatus", () => {
  it("maps every DB status to its board column per the spec", () => {
    // 待办 = todo + queued (queued is still waiting for a slot)
    expect(columnForStatus("todo")).toBe("todo")
    expect(columnForStatus("queued")).toBe("todo")
    // 进行中 = preparing + running — a preparing task already left the queue
    // and is doing setup work (worktree, init command, agent spawn).
    expect(columnForStatus("preparing")).toBe("inProgress")
    expect(columnForStatus("running")).toBe("inProgress")
    // 等你处理 = awaiting_input + review + merging + failed — a merge is an
    // agent turn but the card stays in the review column until it lands.
    expect(columnForStatus("awaiting_input")).toBe("attention")
    expect(columnForStatus("review")).toBe("attention")
    expect(columnForStatus("merging")).toBe("attention")
    expect(columnForStatus("failed")).toBe("attention")
    // 已完成 = done (+ canceled behind the toggle)
    expect(columnForStatus("done")).toBe("done")
    expect(columnForStatus("canceled")).toBe("done")
  })
})

describe("STATUSES_BY_COLUMN", () => {
  it("agrees with columnForStatus and lists every status exactly once", () => {
    // The list view's status filter reads this table; the board reads
    // columnForStatus. A drift between them would put a status in a column of
    // the filter menu that the board files somewhere else.
    for (const [col, statuses] of Object.entries(STATUSES_BY_COLUMN)) {
      for (const status of statuses) {
        expect(columnForStatus(status)).toBe(col as BoardColumnId)
      }
    }
    // Exhaustive by construction: adding a WorkTaskStatus without adding it
    // here fails this list's own type check, and duplicates fail the Set size.
    const every: WorkTaskStatus[] = [
      "todo",
      "queued",
      "preparing",
      "running",
      "awaiting_input",
      "review",
      "merging",
      "done",
      "failed",
      "canceled",
    ]
    expect(new Set(ALL_WORK_TASK_STATUSES).size).toBe(
      ALL_WORK_TASK_STATUSES.length
    )
    expect([...ALL_WORK_TASK_STATUSES].sort()).toEqual([...every].sort())
  })

  it("agrees with the storage layer's copy of the group ids", () => {
    // tasks-board-filter-storage.ts duplicates these ids so it stays free of
    // component imports; a drift would silently reject a stored selection.
    expect([...TASKS_STATUS_GROUPS]).toEqual(BOARD_COLUMN_IDS)
  })
})

describe("filterTasksForList", () => {
  it("returns every non-archived task, freshest first, with no group filter", () => {
    const tasks = [
      task(1, "todo", { updated_at: "2026-08-01T01:00:00Z" }),
      task(2, "running", { updated_at: "2026-08-01T03:00:00Z" }),
      task(3, "canceled", { updated_at: "2026-08-01T02:00:00Z" }),
      task(4, "done", {
        updated_at: "2026-08-01T04:00:00Z",
        archived_at: "2026-08-01T04:00:00Z",
      }),
    ]
    expect(
      filterTasksForList(tasks, null, true, false).map((t) => t.id)
    ).toEqual([2, 3, 1])
    // Archived joins the list — still freshest-first — once the toggle is on.
    expect(
      filterTasksForList(tasks, null, true, true).map((t) => t.id)
    ).toEqual([4, 2, 3, 1])
  })

  it("keeps only the selected column's statuses", () => {
    const tasks = [
      task(1, "todo"),
      task(2, "review"),
      task(3, "failed"),
      task(4, "canceled"),
    ]
    // 等你处理 aggregates review + failed (+ awaiting_input / merging).
    expect(
      filterTasksForList(tasks, "attention", true, false).map((t) => t.id)
    ).toEqual([2, 3])
    // 已完成 is done + canceled — the filter narrows to a whole column, so
    // canceled comes along with it.
    expect(
      filterTasksForList(tasks, "done", true, false).map((t) => t.id)
    ).toEqual([4])
  })

  it("hides canceled tasks unless the toggle is on, like the board", () => {
    // The group filter cannot single `canceled` out (it lives inside Done), so
    // this toggle is the only control that can — shared with the board.
    const tasks = [task(1, "done"), task(2, "canceled")]
    expect(
      filterTasksForList(tasks, null, false, false).map((t) => t.id)
    ).toEqual([1])
    expect(
      filterTasksForList(tasks, "done", false, false).map((t) => t.id)
    ).toEqual([1])
  })

  it("does not mutate the list it was given", () => {
    const tasks = [
      task(1, "todo", { updated_at: "2026-08-01T01:00:00Z" }),
      task(2, "todo", { updated_at: "2026-08-01T05:00:00Z" }),
    ]
    filterTasksForList(tasks, null, true, false)
    expect(tasks.map((t) => t.id)).toEqual([1, 2])
  })
})

describe("groupTasksByColumn", () => {
  it("hides canceled tasks unless the toggle is on", () => {
    const tasks = [task(1, "todo"), task(2, "canceled")]
    const hidden = groupTasksByColumn(tasks, false)
    expect(hidden.done).toHaveLength(0)
    const shown = groupTasksByColumn(tasks, true)
    expect(shown.done.map((t) => t.id)).toEqual([2])
  })

  it("orders every column by updated_at, freshest first", () => {
    const tasks = [
      task(1, "todo", { updated_at: "2026-08-01T01:00:00Z" }),
      task(2, "queued", { updated_at: "2026-08-01T03:00:00Z" }),
      task(3, "preparing", { updated_at: "2026-08-01T01:00:00Z" }),
      task(4, "running", { updated_at: "2026-08-01T04:00:00Z" }),
      task(5, "review", { updated_at: "2026-08-01T02:00:00Z" }),
      task(6, "failed", { updated_at: "2026-08-01T05:00:00Z" }),
      task(7, "done", { updated_at: "2026-08-01T01:00:00Z" }),
      // Canceled no longer sinks to the bottom — one rule per column.
      task(8, "canceled", { updated_at: "2026-08-01T06:00:00Z" }),
    ]
    const grouped = groupTasksByColumn(tasks, true)
    expect(grouped.todo.map((t) => t.id)).toEqual([2, 1])
    expect(grouped.inProgress.map((t) => t.id)).toEqual([4, 3])
    expect(grouped.attention.map((t) => t.id)).toEqual([6, 5])
    expect(grouped.done.map((t) => t.id)).toEqual([8, 7])
  })

  it("keeps board order on equal timestamps, so a drag survives the sort", () => {
    // `reorder` stamps every id it renumbers with the same `updated_at`, so the
    // pending column ties and the stable sort falls back to the new sort_order.
    const stamped = "2026-08-02T00:00:00Z"
    const tasks = [
      task(3, "todo", { sort_order: 0, updated_at: stamped }),
      task(1, "todo", { sort_order: 1, updated_at: stamped }),
      task(2, "queued", { sort_order: 2, updated_at: stamped }),
    ]
    const grouped = groupTasksByColumn(tasks, false)
    expect(grouped.todo.map((t) => t.id)).toEqual([3, 1, 2])
  })

  it("hides archived tasks unless the archive toggle is on", () => {
    const tasks = [
      task(1, "done", { archived_at: "2026-08-01T01:00:00Z" }),
      task(2, "failed", { archived_at: "2026-08-01T01:00:00Z" }),
      task(3, "done"),
    ]
    const hidden = groupTasksByColumn(tasks, false)
    expect(hidden.done.map((t) => t.id)).toEqual([3])
    expect(hidden.attention).toHaveLength(0)
    const shown = groupTasksByColumn(tasks, false, true)
    expect(shown.done.map((t) => t.id)).toEqual([1, 3])
    expect(shown.attention.map((t) => t.id)).toEqual([2])
  })
})

describe("handle later (以后处理)", () => {
  const at = "2026-08-01T02:00:00Z"

  it("files a deferred reviewed or failed task under Done, status unchanged", () => {
    expect(columnForTask(task(1, "review", { deferred_at: at }))).toBe("done")
    expect(columnForTask(task(2, "failed", { deferred_at: at }))).toBe("done")
    // Without the mark, the status decides as before.
    expect(columnForTask(task(3, "review"))).toBe("attention")
    expect(columnForTask(task(4, "failed"))).toBe("attention")
    // A stale mark can never move a live task (the backend clears it on every
    // way out of review / failed, and this is the second guard).
    expect(columnForTask(task(5, "running", { deferred_at: at }))).toBe(
      "inProgress"
    )
    expect(columnForTask(task(6, "merging", { deferred_at: at }))).toBe(
      "attention"
    )
  })

  it("moves the card on the board and in the list's column filter alike", () => {
    const tasks = [
      task(1, "review", { updated_at: "2026-08-01T01:00:00Z" }),
      task(2, "review", {
        deferred_at: at,
        updated_at: "2026-08-01T03:00:00Z",
      }),
      task(3, "done", { updated_at: "2026-08-01T02:00:00Z" }),
    ]
    const grouped = groupTasksByColumn(tasks, false)
    expect(grouped.attention.map((t) => t.id)).toEqual([1])
    // Freshest first, like the rest of Done — deferring stamps updated_at, so
    // the card the user just put aside lands on top.
    expect(grouped.done.map((t) => t.id)).toEqual([2, 3])
    expect(
      filterTasksForList(tasks, "attention", false, false).map((t) => t.id)
    ).toEqual([1])
    expect(
      filterTasksForList(tasks, "done", false, false).map((t) => t.id)
    ).toEqual([2, 3])
  })
})
