import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { WorkTask } from "@/lib/types"
import { TaskRow } from "./task-row"

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
    conversation_id: null,
    connection_id: null,
    base_branch: "main",
    base_sha: "abc",
    work_branch: "task/7",
    cleanup_state: null,
    verdict: null,
    result_summary: null,
    files_changed: 3,
    additions: 10,
    deletions: 2,
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

function renderRow(
  t: WorkTask,
  handlers?: Partial<Record<string, () => void>>
) {
  const noop = () => {}
  const props = {
    onOpen: noop,
    onStart: noop,
    onCancel: noop,
    onRetry: noop,
    onRequeue: noop,
    onViewSession: noop,
    onMerge: noop,
    onDeliverPr: noop,
    onUnqueueMerge: noop,
    onComplete: noop,
    onArchive: noop,
    onEdit: noop,
    onSchedule: noop,
    ...handlers,
  }
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {/* TaskList mounts one per list; the rows' action tooltips need it. */}
      <TooltipProvider>
        <TaskRow
          task={t}
          folderName="repo"
          now={Date.parse("2026-08-01T01:00:00Z")}
          {...props}
        />
      </TooltipProvider>
    </NextIntlClientProvider>
  )
}

describe("TaskRow", () => {
  it("carries the same primary action the card derives for the status", async () => {
    const onMerge = vi.fn()
    renderRow(task(), { onMerge })
    await userEvent.click(screen.getByRole("button", { name: "Merge" }))
    expect(onMerge).toHaveBeenCalledTimes(1)
  })

  it("opens the detail sheet on the row, but not when an action is clicked", async () => {
    const onOpen = vi.fn()
    const onRetry = vi.fn()
    renderRow(task({ status: "failed" }), { onOpen, onRetry })

    await userEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    // The action must not bubble into the row's own open handler.
    expect(onOpen).not.toHaveBeenCalled()

    await userEvent.click(screen.getByText("Answer the question"))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it("does not open the sheet when a row action is activated by keyboard", async () => {
    const onOpen = vi.fn()
    const onArchive = vi.fn()
    renderRow(task({ status: "done" }), { onOpen, onArchive })

    // Focusing opens the button's tooltip, so the raw DOM call needs its own
    // act() — user-event wraps its interactions but this isn't one.
    act(() => screen.getByRole("button", { name: "Archive" }).focus())
    await userEvent.keyboard("{Enter}")
    expect(onArchive).toHaveBeenCalledTimes(1)
    // The keydown bubbles to the row — which must neither open the sheet nor
    // cancel the button's own activation.
    expect(onOpen).not.toHaveBeenCalled()
  })

  it("keeps the session viewer on an archived task", async () => {
    const onViewSession = vi.fn()
    renderRow(
      task({
        status: "done",
        archived_at: "2026-08-01T02:00:00Z",
        conversation_id: 42,
      }),
      { onViewSession }
    )
    // Unarchive is the primary; the session viewer is a secondary — both are
    // on the row, named by their aria-label (the visible label is a tooltip).
    expect(
      screen.getByRole("button", { name: "Unarchive" })
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "View session" }))
    expect(onViewSession).toHaveBeenCalledTimes(1)
  })

  it("does not open the detail sheet when a secondary action is clicked", async () => {
    const onOpen = vi.fn()
    const onEdit = vi.fn()
    const onSchedule = vi.fn()
    renderRow(task({ status: "todo" }), { onOpen, onEdit, onSchedule })

    // Every action is expanded on the row — no overflow menu to open first.
    await userEvent.click(screen.getByRole("button", { name: "Edit" }))
    expect(onEdit).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole("button", { name: "Schedule" }))
    expect(onSchedule).toHaveBeenCalledTimes(1)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it("shows the error of a failed task and the live progress of a running one", () => {
    const { unmount } = renderRow(
      task({ status: "failed", last_error: "boom: exit 1" })
    )
    expect(screen.getByText("boom: exit 1")).toBeTruthy()
    unmount()

    renderRow(task({ status: "running", latest_progress: "installing deps" }))
    expect(screen.getByText("installing deps")).toBeTruthy()
  })

  it("says a round is compacting, in every status that can be", () => {
    // The line exists for exactly this: a resumed round parks on its
    // pre-prompt compaction — `preparing` for a retry or a follow-up,
    // `merging` for a landing — and on a full context window that is minutes
    // with nothing else on screen to explain it.
    for (const status of ["preparing", "merging"] as const) {
      const { unmount } = renderRow(task({ status, compacting: true }))
      expect(screen.getByText("Compacting the session context…")).toBeTruthy()
      unmount()
    }

    // It outranks the agent's own last milestone: it is both the newer truth
    // and the one the user cannot otherwise account for.
    const { unmount } = renderRow(
      task({
        status: "merging",
        compacting: true,
        latest_progress: "installing deps",
      })
    )
    expect(screen.queryByText("installing deps")).toBeNull()
    unmount()

    // And a settled row never claims it, whatever a stale flag says.
    renderRow(task({ status: "review", compacting: true }))
    expect(screen.queryByText("Compacting the session context…")).toBeNull()
  })

  it("marks the row with the agent the task runs under", () => {
    const { unmount } = renderRow(task({ agent_type: "codex" }))
    expect(screen.getByTitle("Codex")).toBeInTheDocument()
    unmount()

    // A payload that never passed through the list's resolution still has the
    // task's own override to go on.
    renderRow(
      task({
        agent_type: null,
        config: {
          prompt_blocks: [],
          display_text: "",
          agent_type: "gemini",
          config_values: {},
        },
      })
    )
    expect(screen.getByTitle("Gemini CLI")).toBeInTheDocument()
  })

  it("badges a deleted worktree, but not a task that never had one", () => {
    const { unmount } = renderRow(
      task({ status: "done", worktree_folder_id: null })
    )
    expect(screen.getByText("Worktree removed")).toBeInTheDocument()
    unmount()

    renderRow(
      task({
        status: "todo",
        files_changed: null,
        worktree_folder_id: null,
        work_branch: null,
        base_branch: null,
        base_sha: null,
      })
    )
    expect(screen.queryByText("Worktree removed")).toBeNull()
  })
})
