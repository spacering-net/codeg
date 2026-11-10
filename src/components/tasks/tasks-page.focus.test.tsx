/**
 * Opened from the aux panel's task tab, the board starts on the project the
 * panel was showing — on its first paint, and only for that visit.
 */
import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { WorkTask } from "@/lib/types"
import { peekTasksFocus, requestTasksFocus } from "@/lib/workbench-focus"

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
  workTaskReorder: vi.fn(),
  workTaskStart: vi.fn(),
  workTaskUpdate: vi.fn(),
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
// The pill reports which folder the board is scoped to.
vi.mock("@/components/shared/folder-select", () => ({
  FolderSelect: ({ value }: { value: number | null }) => (
    <div data-testid="folder-select" data-value={String(value)} />
  ),
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

beforeEach(() => {
  localStorage.clear()
  view.tasks = [
    task({ id: 1, folder_id: 1, title: "Fix the login timeout" }),
    task({ id: 2, folder_id: 2, title: "Redesign the landing page" }),
  ]
})

describe("TasksPage opened from the aux panel", () => {
  it("starts on the panel's project, once", () => {
    requestTasksFocus({ folderId: 2 })
    const { unmount } = mount()
    expect(screen.getByTestId("folder-select")).toHaveAttribute(
      "data-value",
      "2"
    )
    expect(screen.getByText("Redesign the landing page")).toBeInTheDocument()
    expect(screen.queryByText("Fix the login timeout")).not.toBeInTheDocument()
    expect(peekTasksFocus()).toBeNull()

    // The next visit is an ordinary one: every project.
    unmount()
    mount()
    expect(screen.getByTestId("folder-select")).toHaveAttribute(
      "data-value",
      "null"
    )
    expect(screen.getByText("Fix the login timeout")).toBeInTheDocument()
  })
})
