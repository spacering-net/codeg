/**
 * The task page's keyword search, through the page: it narrows the board and
 * the list alike, an empty result says it is the SEARCH that came up empty
 * (not that the column has no tasks), and Escape or the clear button gets the
 * whole board back.
 */
import { render, screen, within } from "@testing-library/react"
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
vi.mock("@/lib/api", () => ({
  workTaskArchive: vi.fn(),
  workTaskCreate: vi.fn(),
  workTaskMergeUnqueue: vi.fn(),
  workTaskReorder: vi.fn(),
  workTaskStart: vi.fn(),
  workTaskUpdate: vi.fn(),
}))
// Every dialog and drawer the page hosts: closed throughout, and each pulls a
// module graph this test has nothing to say about.
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
    run_seq: 0,
    sort_order: 1,
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

const searchBox = () => screen.getByRole("textbox", { name: "Search tasks" })

beforeEach(() => {
  localStorage.clear()
  view.viewMode = "board"
  view.tasks = [
    task({ id: 1, title: "Fix the login timeout", status: "todo" }),
    task({ id: 2, title: "Write the release notes", status: "review" }),
    task({ id: 3, title: "Login page polish", status: "done" }),
  ]
})

describe("TasksPage search", () => {
  it("narrows the board as you type, and says which columns came up empty", async () => {
    const user = userEvent.setup()
    mount()
    expect(screen.getByText("Write the release notes")).toBeInTheDocument()

    await user.type(searchBox(), "login")
    expect(screen.getByText("Fix the login timeout")).toBeInTheDocument()
    expect(screen.getByText("Login page polish")).toBeInTheDocument()
    expect(
      screen.queryByText("Write the release notes")
    ).not.toBeInTheDocument()
    // The Needs-you column has tasks — just none that match.
    expect(screen.getAllByText("No matches").length).toBeGreaterThan(0)
    expect(screen.queryByText("No to-dos yet")).not.toBeInTheDocument()

    // Every word has to match.
    await user.type(searchBox(), " timeout")
    expect(screen.queryByText("Login page polish")).not.toBeInTheDocument()
    expect(screen.getByText("Fix the login timeout")).toBeInTheDocument()
  })

  it("clears with Escape and with the clear button", async () => {
    const user = userEvent.setup()
    mount()

    await user.type(searchBox(), "release{Escape}")
    expect(searchBox()).toHaveValue("")
    expect(screen.getByText("Fix the login timeout")).toBeInTheDocument()

    await user.type(searchBox(), "release")
    await user.click(screen.getByRole("button", { name: "Clear search" }))
    expect(searchBox()).toHaveValue("")
    expect(screen.getByText("Login page polish")).toBeInTheDocument()
  })

  /** In the list, an empty result names the query and offers the way out. */
  it("names the query when the list comes up empty, and clears from there", async () => {
    const user = userEvent.setup()
    view.viewMode = "list"
    mount()

    await user.type(searchBox(), "kubernetes")
    expect(screen.getByText("No tasks match “kubernetes”")).toBeInTheDocument()
    const empty = screen.getByText("No tasks match “kubernetes”")
      .parentElement as HTMLElement
    await user.click(
      within(empty).getByRole("button", { name: "Clear search" })
    )
    expect(screen.getByText("Write the release notes")).toBeInTheDocument()
  })
})
