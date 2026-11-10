/**
 * The aux panel's task tab: the active project's board as a column of
 * sections — what needs you first, Done folded — with the board's own cards,
 * editor and dialogs.
 */
import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import {
  resetTasksBoardFilterCacheForTests,
  saveTasksBoardFilter,
} from "@/lib/tasks-board-filter-storage"
import type { WorkTask } from "@/lib/types"
import { peekTasksFocus } from "@/lib/workbench-focus"

const scene = vi.hoisted(() => ({
  projectFolderId: 1 as number | null,
  setRoute: vi.fn(),
}))
const view = {
  tasks: [] as WorkTask[],
  loading: false,
  refetch: vi.fn(async () => {}),
}

vi.mock("@/contexts/tasks-view-context", () => ({
  useTasksView: () => view,
}))
vi.mock("@/hooks/use-active-project-folder", () => ({
  useActiveProjectFolderId: () => scene.projectFolderId,
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ setRoute: scene.setRoute }),
}))
vi.mock("@/stores/app-workspace-store", () => {
  const state = {
    allFolders: [
      { id: 1, name: "codeg", alias: null, parent_id: null, kind: "regular" },
      { id: 2, name: "site", alias: null, parent_id: null, kind: "regular" },
    ],
  }
  const useStore = (selector: (s: typeof state) => unknown) => selector(state)
  return { useAppWorkspaceStore: useStore }
})
vi.mock("@/lib/api", () => ({
  workTaskArchive: vi.fn(),
  workTaskCreate: vi.fn(),
  workTaskDefer: vi.fn(),
  workTaskMergeUnqueue: vi.fn(),
  workTaskStart: vi.fn(),
  workTaskUpdate: vi.fn(),
}))
// The editor reports what it was opened with; every other dialog stays shut.
vi.mock("@/components/tasks/task-editor-dialog", () => ({
  TaskEditorDialog: ({
    open,
    defaultFolderId,
  }: {
    open: boolean
    defaultFolderId: number | null
  }) =>
    open ? (
      <div role="dialog" data-default-folder={String(defaultFolderId)}>
        editor
      </div>
    ) : null,
}))
vi.mock("@/components/tasks/task-detail-sheet", () => ({
  TaskDetailSheet: ({
    open,
    task,
  }: {
    open: boolean
    task: WorkTask | null
  }) => (open && task ? <div role="dialog">{`detail #${task.id}`}</div> : null),
}))
vi.mock("@/components/tasks/task-merge-dialog", () => ({
  TaskMergeDialog: () => null,
}))
vi.mock("@/components/tasks/task-complete-dialog", () => ({
  TaskCompleteDialog: () => null,
}))
vi.mock("@/components/tasks/task-deliver-pr-dialog", () => ({
  TaskDeliverPrDialog: () => null,
}))
vi.mock("@/components/tasks/task-cancel-dialog", () => ({
  TaskCancelDialog: () => null,
}))
vi.mock("@/components/tasks/task-restart-dialog", () => ({
  TaskRestartDialog: () => null,
}))
vi.mock("@/components/tasks/task-follow-up-dialog", () => ({
  TaskFollowUpDialog: () => null,
}))
vi.mock("@/components/tasks/task-schedule-dialog", () => ({
  TaskScheduleDialog: () => null,
}))
vi.mock("@/components/tasks/task-transcript-dialog", () => ({
  TaskTranscriptDialog: () => null,
}))

import { TasksAuxTab } from "./aux-panel-tasks-tab"

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
      <TasksAuxTab />
    </NextIntlClientProvider>
  )
}

/** The section headers, top to bottom, by their column name. */
function sections(): string[] {
  return screen
    .getAllByRole("button", { expanded: true })
    .concat(screen.queryAllByRole("button", { expanded: false }))
    .sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    )
    .map((header) => header.textContent ?? "")
}

beforeEach(() => {
  localStorage.clear()
  resetTasksBoardFilterCacheForTests()
  scene.projectFolderId = 1
  scene.setRoute.mockClear()
  view.loading = false
  view.tasks = [
    task({ id: 1, title: "Fix the login timeout", status: "todo" }),
    task({ id: 2, title: "Write the release notes", status: "review" }),
    task({ id: 3, title: "Port the parser", status: "running" }),
    task({ id: 4, title: "Login page polish", status: "done" }),
    // Another project's: never on this tab.
    task({ id: 5, folder_id: 2, title: "Redesign the landing page" }),
  ]
})

describe("TasksAuxTab", () => {
  it("stacks the project's board, what needs you first and Done folded", () => {
    mount()
    expect(sections()).toEqual([
      "Needs you1",
      "In progress1",
      "To do1",
      "Done1",
    ])
    expect(screen.getByText("Write the release notes")).toBeInTheDocument()
    expect(screen.getByText("Port the parser")).toBeInTheDocument()
    expect(screen.getByText("Fix the login timeout")).toBeInTheDocument()
    // Folded until asked for.
    expect(screen.queryByText("Login page polish")).not.toBeInTheDocument()
    expect(
      screen.queryByText("Redesign the landing page")
    ).not.toBeInTheDocument()
  })

  it("unfolds a section from its header", async () => {
    const user = userEvent.setup()
    mount()
    const done = screen.getByRole("button", { name: /Done/, expanded: false })
    await user.click(done)
    expect(done).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("Login page polish")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /Needs you/ }))
    expect(
      screen.queryByText("Write the release notes")
    ).not.toBeInTheDocument()
  })

  it("searches the project's tasks, opening every section with a hit", async () => {
    const user = userEvent.setup()
    mount()
    await user.type(
      screen.getByRole("textbox", { name: "Search tasks" }),
      "login"
    )
    // The folded Done section's hit is shown, not hidden behind the fold.
    expect(screen.getByText("Fix the login timeout")).toBeInTheDocument()
    expect(screen.getByText("Login page polish")).toBeInTheDocument()
    expect(screen.queryByText("Port the parser")).not.toBeInTheDocument()

    await user.type(
      screen.getByRole("textbox", { name: "Search tasks" }),
      " kubernetes"
    )
    const empty = screen.getByText("No tasks match “login kubernetes”")
      .parentElement as HTMLElement
    // The empty state's own way out, beside the field's ✕.
    await user.click(
      within(empty).getByRole("button", { name: "Clear search" })
    )
    expect(screen.getByText("Port the parser")).toBeInTheDocument()
  })

  it("opens a card's detail sheet", async () => {
    const user = userEvent.setup()
    mount()
    await user.click(screen.getByText("Port the parser"))
    expect(screen.getByRole("dialog")).toHaveTextContent("detail #3")
  })

  it("starts a new task in the active project", async () => {
    const user = userEvent.setup()
    mount()
    await user.click(screen.getByRole("button", { name: "New task" }))
    expect(screen.getByRole("dialog")).toHaveAttribute(
      "data-default-folder",
      "1"
    )
  })

  it("opens the board on this project", async () => {
    const user = userEvent.setup()
    mount()
    await user.click(screen.getByRole("button", { name: "Open full page" }))
    expect(peekTasksFocus()).toEqual({ folderId: 1 })
    expect(scene.setRoute).toHaveBeenCalledWith("tasks")
  })

  it("offers the first task on a project that has none", async () => {
    const user = userEvent.setup()
    scene.projectFolderId = 2
    view.tasks = view.tasks.filter((t) => t.folder_id !== 2)
    mount()
    const empty = screen.getByText(enMessages.Tasks.empty).parentElement
      ?.parentElement as HTMLElement
    await user.click(within(empty).getByRole("button", { name: "New task" }))
    expect(screen.getByRole("dialog")).toHaveAttribute(
      "data-default-folder",
      "2"
    )
  })

  it("follows the board's canceled / archived toggles as they change", async () => {
    const user = userEvent.setup()
    view.tasks = [
      ...view.tasks,
      task({ id: 7, title: "Drop the old importer", status: "canceled" }),
    ]
    mount()
    await user.click(screen.getByRole("button", { name: /Done/ }))
    // Canceled tasks show by default, as on the board.
    expect(screen.getByText("Drop the old importer")).toBeInTheDocument()

    // Switched off on the board, while this tab stays mounted.
    act(() =>
      saveTasksBoardFilter({ showCanceled: false, showArchived: false })
    )
    expect(screen.queryByText("Drop the old importer")).not.toBeInTheDocument()
    expect(screen.getByText("Login page polish")).toBeInTheDocument()
  })

  it("explains itself when there is no project", () => {
    scene.projectFolderId = null
    mount()
    expect(
      screen.getByText(enMessages.Folder.auxPanel.noFolderTitle)
    ).toBeInTheDocument()
  })
})
