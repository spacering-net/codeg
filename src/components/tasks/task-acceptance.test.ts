import { describe, expect, it } from "vitest"
import type { WorkTask } from "@/lib/types"
import {
  canDefer,
  canDeliverToPr,
  canRemoveWorktree,
  deliveredPrUrl,
  hasNothingToMerge,
  isAnotherTaskMerging,
  isDeferred,
  isMergeQueued,
  isWorktreeGone,
  mergeQueueRanks,
  mustDeliverToPr,
  usesMergeRequests,
  worktreeWasRemoved,
} from "./task-acceptance"
import { buildTaskActions } from "./task-actions"

/** A parked merge, reduced to what the queue helpers actually read. */
function queued(at: string): WorkTask["merge_queued"] {
  return { message: null, delete_worktree: true, queued_at: at }
}

function task(overrides?: Partial<WorkTask>): WorkTask {
  return {
    id: 7,
    folder_id: 1,
    title: "Answer the question",
    config: null,
    status: "review",
    failure_reason: null,
    last_error: null,
    run_seq: 1,
    sort_order: 1,
    worktree_folder_id: 9,
    conversation_id: 3,
    connection_id: null,
    base_branch: "main",
    base_sha: "abc",
    work_branch: "task/7",
    cleanup_state: null,
    verdict: null,
    result_summary: null,
    files_changed: 0,
    additions: 0,
    deletions: 0,
    merge_commit: null,
    preflight: null,
    archived_at: null,
    scheduled_at: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    started_at: null,
    settled_at: null,
    finished_at: null,
    ...overrides,
  }
}

describe("hasNothingToMerge", () => {
  it("is true for a reviewed task whose diff came back empty", () => {
    expect(hasNothingToMerge(task())).toBe(true)
  })

  it("is false once anything changed", () => {
    expect(hasNothingToMerge(task({ files_changed: 1 }))).toBe(false)
  })

  it("keeps merge as the default when the stats are unknown", () => {
    // `null` = the engine could not read the worktree, NOT "nothing changed".
    expect(hasNothingToMerge(task({ files_changed: null }))).toBe(false)
  })

  it("only speaks for tasks that are actually up for review", () => {
    expect(hasNothingToMerge(task({ status: "running" }))).toBe(false)
    expect(hasNothingToMerge(task({ status: "done" }))).toBe(false)
  })

  it("offers complete when the worktree is gone — merge could only fail", () => {
    // Detached entirely (removed via the app)…
    expect(
      hasNothingToMerge(task({ files_changed: 3, worktree_folder_id: null }))
    ).toBe(true)
    // …or recorded but no longer usable (folder/dir removed behind the app).
    expect(
      hasNothingToMerge(task({ files_changed: 3, worktree_missing: true }))
    ).toBe(true)
    // Still only in review: elsewhere the state carries no acceptance.
    expect(
      hasNothingToMerge(
        task({ status: "running", files_changed: 3, worktree_missing: true })
      )
    ).toBe(false)
  })
})

describe("the merge queue", () => {
  it("marks only reviewed tasks that actually took a place in line", () => {
    expect(isMergeQueued(task())).toBe(false)
    expect(
      isMergeQueued(task({ merge_queued: queued("2026-08-01T10:00:00Z") }))
    ).toBe(true)
    // A dispatched merge left the queue: the row is `merging` now, and the
    // stamp it may still carry must not read as "still waiting".
    expect(
      isMergeQueued(
        task({
          status: "merging",
          merge_queued: queued("2026-08-01T10:00:00Z"),
        })
      )
    ).toBe(false)
  })

  it("numbers each project's queue by request order, ties broken by id", () => {
    const ranks = mergeQueueRanks([
      task({ id: 1, merge_queued: queued("2026-08-01T10:00:02Z") }),
      task({ id: 2, merge_queued: queued("2026-08-01T10:00:01Z") }),
      // Same instant as #2 — the backend breaks the tie by id, and so does the
      // display.
      task({ id: 3, merge_queued: queued("2026-08-01T10:00:01Z") }),
      // Another project keeps its own line.
      task({
        id: 4,
        folder_id: 2,
        merge_queued: queued("2026-08-01T10:00:05Z"),
      }),
      // Not queued at all.
      task({ id: 5 }),
    ])
    expect(ranks.get(2)).toBe(1)
    expect(ranks.get(3)).toBe(2)
    expect(ranks.get(1)).toBe(3)
    expect(ranks.get(4)).toBe(1)
    expect(ranks.has(5)).toBe(false)
  })

  it("orders by instant, not by the text of the timestamp", () => {
    // RFC 3339 with a variable number of fractional digits: "…:00Z" sorts
    // AFTER "…:00.5Z" as a string, and before it as a time.
    const ranks = mergeQueueRanks([
      task({ id: 1, merge_queued: queued("2026-08-01T10:00:00.500Z") }),
      task({ id: 2, merge_queued: queued("2026-08-01T10:00:00Z") }),
    ])
    expect(ranks.get(2)).toBe(1)
    expect(ranks.get(1)).toBe(2)
  })

  it("knows when a project's merge slot is busy with someone else", () => {
    const mine = task({ id: 1 })
    const tasks = [mine, task({ id: 2, status: "merging" })]
    expect(isAnotherTaskMerging(tasks, mine)).toBe(true)
    // Another PROJECT's landing is not this project's slot.
    expect(isAnotherTaskMerging(tasks, task({ id: 3, folder_id: 2 }))).toBe(
      false
    )
  })

  it("does not count the subject task's own merge", () => {
    // The window this exists for: the engine flips review→merging and
    // broadcasts it seconds before the dispatch call returns, so the row the
    // open dialog reads says "merging" while its own submit is still in
    // flight. Counting that would tell the user another task holds the slot.
    const mine = task({ id: 1, status: "merging" })
    expect(isAnotherTaskMerging([mine], mine)).toBe(false)
  })
})

describe("isWorktreeGone", () => {
  it("reads either the detached pointer or the backend's missing stamp", () => {
    expect(isWorktreeGone(task())).toBe(false)
    expect(isWorktreeGone(task({ worktree_folder_id: null }))).toBe(true)
    expect(isWorktreeGone(task({ worktree_missing: true }))).toBe(true)
  })
})

describe("worktreeWasRemoved", () => {
  it("tells a deleted worktree from one that never existed", () => {
    // Ran and detached — the branch is the witness a worktree once existed.
    expect(
      worktreeWasRemoved(task({ status: "done", worktree_folder_id: null }))
    ).toBe(true)
    // Recorded but no longer usable on disk.
    expect(worktreeWasRemoved(task({ worktree_missing: true }))).toBe(true)
    // Intact worktree — nothing was removed.
    expect(worktreeWasRemoved(task())).toBe(false)
    // Just created, never initialized: nothing existed to remove.
    expect(
      worktreeWasRemoved(
        task({
          status: "todo",
          worktree_folder_id: null,
          work_branch: null,
          base_branch: null,
          base_sha: null,
        })
      )
    ).toBe(false)
  })
})

describe("canRemoveWorktree", () => {
  const done = { status: "done" } as const

  it("offers the removal to a settled task still holding its worktree", () => {
    // Every way of stopping lets the user KEEP the worktree — the merge /
    // complete dialogs' checkbox, and the cancel dialog's — so this is the
    // state the drawer's own removal exists for. Canceled counts: that task
    // can still be requeued, but a checkout the user has no intention of
    // reopening should be reclaimable without deleting the task (and with it
    // the record of why it was stopped).
    expect(canRemoveWorktree(task({ ...done }))).toBe(true)
    expect(canRemoveWorktree(task({ status: "canceled" }))).toBe(true)
  })

  it("stays out of an unsettled task's way", () => {
    // Mid-run the checkout is in use, and a reviewed task's worktree is what
    // the acceptance is about to read — neither is housekeeping.
    for (const status of ["todo", "running", "review", "merging"] as const) {
      expect(canRemoveWorktree(task({ status }))).toBe(false)
    }
  })

  it("says nothing when there is no worktree left to remove", () => {
    expect(canRemoveWorktree(task({ ...done, worktree_folder_id: null }))).toBe(
      false
    )
    // Recorded, but its folder / directory went away behind the app — the card
    // already reports that one as removed.
    expect(canRemoveWorktree(task({ ...done, worktree_missing: true }))).toBe(
      false
    )
    // A canceled task that took its worktree along with the stop is in exactly
    // the same place — the checkbox already did this call.
    expect(
      canRemoveWorktree(task({ status: "canceled", worktree_folder_id: null }))
    ).toBe(false)
  })

  it("defers to the retry entry after a failed cleanup", () => {
    // Same backend call, and that button names the failure — two of them in
    // one bar would just be the same action twice.
    expect(canRemoveWorktree(task({ ...done, cleanup_state: "failed" }))).toBe(
      false
    )
  })
})

describe("canDeliverToPr", () => {
  const issue = { source_kind: "forge_issue", files_changed: 3 } as const

  it("offers delivery for a reviewed task that came from the forge", () => {
    expect(canDeliverToPr(task({ ...issue }))).toBe(true)
    // A pull-request task delivers too — back onto its own branch.
    expect(canDeliverToPr(task({ ...issue, source_kind: "forge_pr" }))).toBe(
      true
    )
    // A local task has no repository to push to.
    expect(canDeliverToPr(task({ files_changed: 3 }))).toBe(false)
    // Only from review: nothing to push before, nothing left after.
    expect(canDeliverToPr(task({ ...issue, status: "running" }))).toBe(false)
    expect(canDeliverToPr(task({ ...issue, status: "done" }))).toBe(false)
  })

  it("withholds it when there is nothing to put in a pull request", () => {
    // GitHub answers an empty pull request with a 422 …
    expect(canDeliverToPr(task({ ...issue, files_changed: 0 }))).toBe(false)
    // … and a gone worktree has no branch left to push.
    expect(canDeliverToPr(task({ ...issue, worktree_folder_id: null }))).toBe(
      false
    )
    // Unknown stats are NOT "empty" — same fallback the merge button takes.
    expect(canDeliverToPr(task({ ...issue, files_changed: null }))).toBe(true)
  })
})

describe("mustDeliverToPr", () => {
  it("marks the tasks whose local merge the backend refuses", () => {
    // A pull request's work belongs on the pull request's branch: landing it
    // locally would take those changes in behind the author's back.
    expect(mustDeliverToPr(task({ source_kind: "forge_pr" }))).toBe(true)
    // An issue's task may legitimately be landed here instead.
    expect(mustDeliverToPr(task({ source_kind: "forge_issue" }))).toBe(false)
    expect(mustDeliverToPr(task())).toBe(false)
  })
})

describe("usesMergeRequests", () => {
  it("follows the task's own provenance, not a guess", () => {
    const gitlab = { provider: "gitlab" } as WorkTask["source_meta"]
    const github = { provider: "github" } as WorkTask["source_meta"]
    expect(
      usesMergeRequests(task({ source_kind: "forge_pr", source_meta: gitlab }))
    ).toBe(true)
    expect(
      usesMergeRequests(task({ source_kind: "forge_pr", source_meta: github }))
    ).toBe(false)
    // No provenance at all (a local task, or a row from before the column
    // existed) keeps GitHub's wording, which is what it has always shown.
    expect(usesMergeRequests(task())).toBe(false)
    expect(usesMergeRequests(null)).toBe(false)
  })
})

describe("deliveredPrUrl", () => {
  it("links only a task that actually finished by delivering", () => {
    const url = "https://github.com/acme/app/pull/42"
    const meta = { result_pr: url } as WorkTask["source_meta"]
    expect(
      deliveredPrUrl(
        task({
          status: "done",
          completion_kind: "delivered_pr",
          source_meta: meta,
        })
      )
    ).toBe(url)
    // A merged task's source snapshot has no pull request to show.
    expect(
      deliveredPrUrl(task({ status: "done", completion_kind: "merged" }))
    ).toBeNull()
    // Rows that finished before the column existed stay silent rather than
    // guessing from a stale snapshot.
    expect(
      deliveredPrUrl(task({ status: "done", source_meta: meta }))
    ).toBeNull()
  })
})

describe("the acceptance a review-only pull-request task offers", () => {
  const handlers = {
    onStart: () => {},
    onCancel: () => {},
    onRetry: () => {},
    onRequeue: () => {},
    onViewSession: () => {},
    onMerge: () => {},
    onDeliverPr: () => {},
    onUnqueueMerge: () => {},
    onComplete: () => {},
    onArchive: () => {},
    onDefer: () => {},
    onFollowUp: () => {},
    onEdit: () => {},
    onSchedule: () => {},
  }
  const primary = (t: WorkTask): string | null =>
    buildTaskActions(t, (key) => key, handlers).primary?.label ?? null

  const fromPr = { source_kind: "forge_pr" as const, conversation_id: null }

  // A task triggered from a pull request is checked out ON that pull request,
  // so its worktree holds the whole contribution before the agent starts. The
  // counters are measured from that checkout point, which is what keeps a
  // review turn that committed nothing at zero here — anything else offers a
  // push back with nothing in it (and the backend refuses that one).
  it("is completing, not a push back that would carry nothing", () => {
    const reviewOnly = task({ ...fromPr, files_changed: 0 })
    expect(hasNothingToMerge(reviewOnly)).toBe(true)
    expect(canDeliverToPr(reviewOnly)).toBe(false)
    expect(primary(reviewOnly)).toBe("actionComplete")
  })

  it("is the push back once the agent has committed something of its own", () => {
    const withWork = task({ ...fromPr, files_changed: 2 })
    expect(canDeliverToPr(withWork)).toBe(true)
    expect(primary(withWork)).toBe("actionDeliverPrBack")
  })
})

describe("handle later (以后处理)", () => {
  const at = "2026-08-01T02:00:00Z"

  it("is offered on a reviewed or failed task, and nowhere else", () => {
    expect(canDefer(task())).toBe(true)
    expect(canDefer(task({ status: "failed" }))).toBe(true)
    // A live agent is answered or stopped, never parked out of sight; a merge
    // is in flight; finished tasks have nothing left to handle.
    for (const status of [
      "todo",
      "queued",
      "preparing",
      "running",
      "awaiting_input",
      "merging",
      "done",
      "canceled",
    ] as const) {
      expect(canDefer(task({ status }))).toBe(false)
    }
  })

  it("is not offered twice, on an archived task, or on one queued to merge", () => {
    expect(canDefer(task({ deferred_at: at }))).toBe(false)
    expect(canDefer(task({ status: "failed", archived_at: at }))).toBe(false)
    // An acceptance already made — the decision left is leaving the queue.
    expect(canDefer(task({ merge_queued: queued(at) }))).toBe(false)
  })

  it("reads the mark only where it can live", () => {
    expect(isDeferred(task({ deferred_at: at }))).toBe(true)
    expect(isDeferred(task({ status: "failed", deferred_at: at }))).toBe(true)
    expect(isDeferred(task())).toBe(false)
    // The backend clears the mark on every way out of review / failed; a stale
    // one must still never pull a running task off "In progress".
    expect(isDeferred(task({ status: "running", deferred_at: at }))).toBe(false)
    expect(isDeferred(task({ status: "done", deferred_at: at }))).toBe(false)
  })
})

describe("the actions a deferred task offers", () => {
  const calls: string[] = []
  const handler = (name: string) => () => {
    calls.push(name)
  }
  const handlers = {
    onStart: handler("start"),
    onCancel: handler("cancel"),
    onRetry: handler("retry"),
    onRequeue: handler("requeue"),
    onViewSession: handler("viewSession"),
    onMerge: handler("merge"),
    onDeliverPr: handler("deliverPr"),
    onUnqueueMerge: handler("unqueueMerge"),
    onComplete: handler("complete"),
    onArchive: handler("archive"),
    onDefer: handler("defer"),
    onFollowUp: handler("followUp"),
    onEdit: handler("edit"),
    onSchedule: handler("schedule"),
  }
  const actions = (t: WorkTask) => {
    const { primary, secondaries } = buildTaskActions(t, (key) => key, handlers)
    return {
      primary: primary?.label ?? null,
      secondaries: secondaries.map((s) => s.label),
      click: (label: string) => {
        calls.length = 0
        const item = [primary, ...secondaries].find((a) => a?.label === label)
        item?.onClick()
        return [...calls]
      },
    }
  }
  const deferredAt = "2026-08-01T02:00:00Z"

  it("puts a reviewed task aside from its card, beside the acceptance", () => {
    const reviewed = actions(task({ files_changed: 3 }))
    expect(reviewed.primary).toBe("actionMerge")
    expect(reviewed.secondaries).toEqual(["actionDefer", "actionViewSession"])
    expect(reviewed.click("actionDefer")).toEqual(["defer"])
  })

  it("leads a deferred reviewed task with the follow-up that resumes it", () => {
    // Picking it back up is what the card in Done is for: the follow-up starts
    // the next run straight from there.
    const parked = actions(task({ files_changed: 3, deferred_at: deferredAt }))
    expect(parked.primary).toBe("actionFollowUp")
    expect(parked.click("actionFollowUp")).toEqual(["followUp"])
    expect(parked.secondaries).toEqual(["actionUndefer", "actionViewSession"])
    expect(parked.click("actionUndefer")).toEqual(["defer"])
  })

  it("keeps a failed task's retry, deferred or not", () => {
    const failed = actions(task({ status: "failed" }))
    expect(failed.primary).toBe("actionRetry")
    expect(failed.secondaries).toEqual([
      "actionEdit",
      "actionDefer",
      "actionArchive",
      "actionViewSession",
    ])
    const parked = actions(task({ status: "failed", deferred_at: deferredAt }))
    expect(parked.primary).toBe("actionRetry")
    expect(parked.secondaries).toEqual([
      "actionEdit",
      "actionUndefer",
      "actionArchive",
      "actionViewSession",
    ])
  })

  it("never offers it where it cannot apply", () => {
    // Queued to merge: only the way out of the queue.
    expect(
      actions(
        task({ files_changed: 3, merge_queued: queued("2026-08-01T00:30:00Z") })
      ).secondaries
    ).toEqual(["actionUnqueueMerge", "actionViewSession"])
    // Waiting on a question: the agent is live — cancel, not park.
    expect(actions(task({ status: "awaiting_input" })).secondaries).toEqual([
      "actionViewSession",
    ])
    // Archived: one way back, which is unarchiving.
    const archived = actions(
      task({
        status: "failed",
        archived_at: deferredAt,
        deferred_at: deferredAt,
      })
    )
    expect(archived.primary).toBe("actionUnarchive")
    expect(archived.secondaries).toEqual(["actionViewSession"])
  })
})
