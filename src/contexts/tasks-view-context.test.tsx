import { act, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkTask } from "@/lib/types"

const listMock = vi.fn()
const notifyMock = vi.fn()
let changedHandler: (() => void) | null = null
let reconnectHandler: (() => void) | null = null

vi.mock("@/lib/api", () => ({
  workTaskList: (...args: unknown[]) => listMock(...args),
}))
vi.mock("@/lib/desktop-notification", () => ({
  notifyDesktop: (...args: unknown[]) => notifyMock(...args),
}))
// Stable t — a fresh function per render loops the notification effect.
const stableT = (key: string, values?: Record<string, unknown>) =>
  values ? `${key}:${JSON.stringify(values)}` : key
vi.mock("next-intl", () => ({
  useTranslations: () => stableT,
}))
vi.mock("@/stores/app-workspace-store", () => ({
  useAppWorkspaceStore: {
    getState: () => ({ folders: [{ id: 1, name: "proj", alias: null }] }),
  },
}))
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn((channel: string, cb: () => void) => {
    if (channel === "task://changed") changedHandler = cb
    return Promise.resolve(() => {
      changedHandler = null
    })
  }),
  onTransportReconnect: vi.fn((cb: () => void) => {
    reconnectHandler = cb
    return () => {
      reconnectHandler = null
    }
  }),
}))

import { TasksViewProvider, useTasksView } from "./tasks-view-context"

function sample(id: number, status: WorkTask["status"]): WorkTask {
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
  }
}

function Probe() {
  const { tasks, attentionCount } = useTasksView()
  return (
    <div>
      <span data-testid="count">{tasks.length}</span>
      <span data-testid="attention">{attentionCount}</span>
    </div>
  )
}

beforeEach(() => {
  listMock.mockReset()
  notifyMock.mockReset()
  changedHandler = null
  reconnectHandler = null
})

describe("TasksViewProvider", () => {
  it("fetches on mount and refetches on task://changed nudges", async () => {
    listMock.mockResolvedValueOnce([sample(1, "todo")])
    render(
      <TasksViewProvider>
        <Probe />
      </TasksViewProvider>
    )
    await waitFor(() =>
      expect(screen.getByTestId("count").textContent).toBe("1")
    )
    expect(listMock).toHaveBeenCalledTimes(1)

    // A backend nudge triggers a refetch that replaces the list.
    listMock.mockResolvedValueOnce([
      sample(1, "review"),
      sample(2, "awaiting_input"),
      sample(3, "running"),
    ])
    await act(async () => {
      changedHandler?.()
    })
    await waitFor(() =>
      expect(screen.getByTestId("count").textContent).toBe("3")
    )
    // Attention = awaiting_input + review + failed (running excluded).
    expect(screen.getByTestId("attention").textContent).toBe("2")
  })

  it("refetches on transport reconnect and keeps data on fetch errors", async () => {
    listMock.mockResolvedValueOnce([sample(1, "failed")])
    render(
      <TasksViewProvider>
        <Probe />
      </TasksViewProvider>
    )
    await waitFor(() =>
      expect(screen.getByTestId("attention").textContent).toBe("1")
    )

    // A transient error must not blank the board.
    listMock.mockRejectedValueOnce(new Error("boom"))
    await act(async () => {
      reconnectHandler?.()
    })
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId("count").textContent).toBe("1")
  })

  it("notifies on review/failed flips but never for the initial load", async () => {
    listMock.mockResolvedValueOnce([sample(1, "review"), sample(2, "running")])
    render(
      <TasksViewProvider>
        <Probe />
      </TasksViewProvider>
    )
    await waitFor(() =>
      expect(screen.getByTestId("count").textContent).toBe("2")
    )
    // Pre-existing review task = history, not news.
    expect(notifyMock).not.toHaveBeenCalled()

    listMock.mockResolvedValueOnce([sample(1, "review"), sample(2, "failed")])
    await act(async () => {
      changedHandler?.()
    })
    await waitFor(() => expect(notifyMock).toHaveBeenCalledTimes(1))
    expect(notifyMock).toHaveBeenCalledWith("work_task", {
      title: "proj - Codeg",
      body: expect.stringContaining("notifyFailed"),
      // Carries the task title, so it needs a variant that doesn't.
      redactedBody: "notifyFailedRedacted",
    })
  })
})
