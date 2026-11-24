/**
 * The complete dialog through the hook that wires it (#1166): it keeps the row
 * captured when it opened — so a refetch cannot re-seed the user's choices —
 * yet closes once the LIVE row shows the task has changes to merge after all
 * (re-measured after a turn outside the task, or by the refused completion).
 */
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { WorkTask, WorkTaskFolderSettings } from "@/lib/types"

const completeMock = vi.fn()
const settingsMock = vi.fn()
vi.mock("@/lib/api", () => ({
  workTaskArchive: vi.fn(),
  workTaskComplete: (...args: unknown[]) => completeMock(...args),
  workTaskCreate: vi.fn(),
  workTaskDefer: vi.fn(),
  workTaskMergeUnqueue: vi.fn(),
  workTaskSetWriteback: vi.fn(),
  workTaskSettingsEffective: (...args: unknown[]) => settingsMock(...args),
  workTaskStart: vi.fn(),
  workTaskStopBackgroundWait: vi.fn(),
  workTaskUpdate: vi.fn(),
}))
vi.mock("./task-detail-sheet", () => ({ TaskDetailSheet: () => null }))
vi.mock("./task-editor-dialog", () => ({ TaskEditorDialog: () => null }))
vi.mock("./task-merge-dialog", () => ({ TaskMergeDialog: () => null }))
vi.mock("./task-deliver-pr-dialog", () => ({
  TaskDeliverPrDialog: () => null,
}))
vi.mock("./task-cancel-dialog", () => ({ TaskCancelDialog: () => null }))
vi.mock("./task-restart-dialog", () => ({ TaskRestartDialog: () => null }))
vi.mock("./task-schedule-dialog", () => ({ TaskScheduleDialog: () => null }))
vi.mock("./task-follow-up-dialog", () => ({
  TaskFollowUpDialog: () => null,
}))
vi.mock("./task-transcript-dialog", () => ({
  TaskTranscriptDialog: () => null,
}))

import { useTaskDialogs } from "./use-task-dialogs"

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

function settings(): WorkTaskFolderSettings {
  return {
    default_agent_type: null,
    mode_id: null,
    config_values: {},
    auto_process: false,
    max_concurrent: 2,
    merge_strategy: "squash",
    auto_merge: false,
    auto_compact_percent: 0,
    delete_worktree_default: true,
  }
}

function Harness({ tasks }: { tasks: WorkTask[] }) {
  const { handlersFor, dialogs } = useTaskDialogs({
    tasks,
    refetch: async () => {},
    folderNames: new Map(),
    defaultFolderId: null,
  })
  return (
    <>
      <button type="button" onClick={() => handlersFor(tasks[0]).onComplete()}>
        open complete
      </button>
      {dialogs}
    </>
  )
}

function renderHarness(tasks: WorkTask[]) {
  const view = (rows: WorkTask[]) => (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <Harness tasks={rows} />
    </NextIntlClientProvider>
  )
  const utils = render(view(tasks))
  return { rerender: (rows: WorkTask[]) => utils.rerender(view(rows)) }
}

beforeEach(() => {
  completeMock.mockReset()
  settingsMock.mockReset()
  settingsMock.mockResolvedValue(settings())
})

describe("useTaskDialogs — complete dialog", () => {
  it("keeps the user's choices across a refetch of the same task", async () => {
    const { rerender } = renderHarness([task()])
    await userEvent.click(screen.getByRole("button", { name: "open complete" }))
    const box = await screen.findByRole("checkbox", {
      name: /Delete the worktree/,
    })
    await waitFor(() => expect(box).toBeChecked())
    await userEvent.click(box)
    expect(box).not.toBeChecked()

    // The provider hands out fresh objects on every refetch.
    act(() => rerender([task({ updated_at: "2026-08-01T00:00:01Z" })]))

    expect(
      screen.getByRole("checkbox", { name: /Delete the worktree/ })
    ).not.toBeChecked()
    expect(settingsMock).toHaveBeenCalledTimes(1)
  })

  it("keeps an in-flight completion disabled across a refetch", async () => {
    completeMock.mockReturnValue(new Promise(() => {}))
    const { rerender } = renderHarness([task()])
    await userEvent.click(screen.getByRole("button", { name: "open complete" }))
    await screen.findByRole("checkbox", { name: /Delete the worktree/ })
    await userEvent.click(screen.getByRole("button", { name: "Complete" }))
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Complete" })).toBeDisabled()
    )

    act(() => rerender([task({ updated_at: "2026-08-01T00:00:01Z" })]))

    expect(screen.getByRole("button", { name: "Complete" })).toBeDisabled()
  })

  it("closes once the live row shows changes to merge", async () => {
    const { rerender } = renderHarness([task()])
    await userEvent.click(screen.getByRole("button", { name: "open complete" }))
    expect(await screen.findByRole("dialog")).toBeInTheDocument()

    act(() => rerender([task({ files_changed: 7, additions: 40 })]))

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(completeMock).not.toHaveBeenCalled()
  })

  it("stays open for a gone worktree whatever its counters say", async () => {
    const gone = { worktree_missing: true, files_changed: 3 }
    const { rerender } = renderHarness([task(gone)])
    await userEvent.click(screen.getByRole("button", { name: "open complete" }))
    expect(await screen.findByRole("dialog")).toBeInTheDocument()

    act(() => rerender([task({ ...gone, updated_at: "2026-08-01T00:00:01Z" })]))

    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })
})
