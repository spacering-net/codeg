/**
 * "以后处理" through the page: a reviewed card in "Needs you" can be put aside,
 * a deferred one is filed under Done and leads with "继续处理" (the follow-up
 * dialog that sends it back to the agent), and the Done column's "Archive
 * all" leaves deferred cards alone — they are what the user meant to come back
 * to, not finished work.
 */
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { WorkTask } from "@/lib/types"

const view = {
  tasks: [] as WorkTask[],
  loading: false,
  refetch: vi.fn(async () => {}),
  viewMode: "board" as "board" | "list",
}
vi.mock("@/contexts/tasks-view-context", () => ({
  useTasksView: () => view,
}))
vi.mock("@/stores/app-workspace-store", () => {
  const state = {
    folders: [
      { id: 1, name: "codeg", alias: null, parent_id: null, kind: "regular" },
    ],
  }
  const useStore = (selector: (s: typeof state) => unknown) => selector(state)
  return { useAppWorkspaceStore: useStore }
})
const workTaskArchive = vi.fn(async () => {})
const workTaskDefer = vi.fn(async () => {})
vi.mock("@/lib/api", () => ({
  workTaskArchive: (...args: unknown[]) => workTaskArchive(...(args as [])),
  workTaskCreate: vi.fn(),
  workTaskDefer: (...args: unknown[]) => workTaskDefer(...(args as [])),
  workTaskMergeUnqueue: vi.fn(),
  workTaskReorder: vi.fn(),
  workTaskStart: vi.fn(),
  workTaskUpdate: vi.fn(),
}))
// The dialog under test is the follow-up one; it renders a marker naming the
// task it was opened for. Everything else stays closed.
vi.mock("./task-follow-up-dialog", () => ({
  TaskFollowUpDialog: ({
    open,
    task,
  }: {
    open: boolean
    task: WorkTask | null
  }) =>
    open && task ? <div role="dialog">{`follow up #${task.id}`}</div> : null,
}))
vi.mock("./task-detail-sheet", () => ({ TaskDetailSheet: () => null }))
vi.mock("./task-editor-dialog", () => ({ TaskEditorDialog: () => null }))
vi.mock("./task-merge-dialog", () => ({ TaskMergeDialog: () => null }))
vi.mock("./task-complete-dialog", () => ({ TaskCompleteDialog: () => null }))
vi.mock("./task-deliver-pr-dialog", () => ({
  TaskDeliverPrDialog: () => null,
}))
vi.mock("./task-cancel-dialog", () => ({ TaskCancelDialog: () => null }))
vi.mock("./task-restart-dialog", () => ({ TaskRestartDialog: () => null }))
vi.mock("./task-schedule-dialog", () => ({ TaskScheduleDialog: () => null }))
vi.mock("./task-settings-dialog", () => ({ TaskSettingsDialog: () => null }))
vi.mock("./task-transcript-dialog", () => ({
  TaskTranscriptDialog: () => null,
}))
vi.mock("@/components/shared/folder-select", () => ({
  FolderSelect: () => <div data-testid="folder-select" />,
}))

import { TasksPage } from "./tasks-page"

function task(overrides: Partial<WorkTask>): WorkTask {
  return {
    id: 1,
    folder_id: 1,
    title: "untitled",
    config: null,
    status: "todo",
    failure_reason: null,
    last_error: null,
    run_seq: 1,
    sort_order: 1,
    worktree_folder_id: 9,
    conversation_id: null,
    connection_id: null,
    base_branch: "main",
    base_sha: "abc",
    work_branch: null,
    cleanup_state: null,
    verdict: null,
    result_summary: null,
    files_changed: 3,
    additions: 1,
    deletions: 1,
    merge_commit: null,
    preflight: null,
    archived_at: null,
    scheduled_at: null,
    created_at: "2026-10-14T00:00:00Z",
    updated_at: "2026-10-14T00:00:00Z",
    started_at: null,
    settled_at: null,
    finished_at: null,
    ...overrides,
  }
}

function mount() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TasksPage />
    </NextIntlClientProvider>
  )
}

/** A board column, found by its heading. */
function column(name: string): HTMLElement {
  const heading = screen.getByRole("heading", { level: 2, name })
  // heading → header row → column
  return heading.parentElement!.parentElement as HTMLElement
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  view.viewMode = "board"
  view.tasks = [
    task({ id: 1, title: "Review me now", status: "review" }),
    task({
      id: 2,
      title: "Review me later",
      status: "review",
      deferred_at: "2026-10-14T02:00:00Z",
      updated_at: "2026-10-14T02:00:00Z",
    }),
    task({ id: 3, title: "Landed already", status: "done" }),
  ]
})

describe("TasksPage handle later", () => {
  it("files a deferred task under Done and the rest where they were", () => {
    mount()
    const attention = column("Needs you")
    const done = column("Done")
    expect(within(attention).getByText("Review me now")).toBeInTheDocument()
    expect(within(attention).queryByText("Review me later")).toBeNull()
    expect(within(done).getByText("Review me later")).toBeInTheDocument()
    expect(within(done).getByText("Landed already")).toBeInTheDocument()
  })

  it("puts a reviewed card aside from its footer", async () => {
    const user = userEvent.setup()
    mount()
    await user.click(
      within(column("Needs you")).getByRole("button", { name: "Handle later" })
    )
    await waitFor(() => expect(workTaskDefer).toHaveBeenCalledWith(1, true))
    expect(view.refetch).toHaveBeenCalled()
  })

  it("follows a deferred card back up through the follow-up dialog", async () => {
    const user = userEvent.setup()
    mount()
    const done = column("Done")
    await user.click(within(done).getByRole("button", { name: "Follow up" }))
    expect(screen.getByRole("dialog")).toHaveTextContent("follow up #2")

    await user.click(
      within(done).getByRole("button", { name: "Back to Needs you" })
    )
    await waitFor(() => expect(workTaskDefer).toHaveBeenCalledWith(2, false))
  })

  it("archives the finished cards of Done, never the deferred ones", async () => {
    const user = userEvent.setup()
    mount()
    await user.click(screen.getByRole("button", { name: "Archive all" }))
    await waitFor(() => expect(workTaskArchive).toHaveBeenCalledTimes(1))
    expect(workTaskArchive).toHaveBeenCalledWith(3, true)
  })

  it("offers no Archive all when Done holds only deferred cards", () => {
    view.tasks = view.tasks.filter((t) => t.id !== 3)
    mount()
    expect(
      within(column("Done")).getByText("Review me later")
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Archive all" })).toBeNull()
  })
})
