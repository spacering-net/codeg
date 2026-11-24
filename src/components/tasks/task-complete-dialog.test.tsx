import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import type { WorkTask, WorkTaskFolderSettings } from "@/lib/types"

const completeMock = vi.fn().mockResolvedValue(undefined)
const settingsMock = vi.fn()

vi.mock("@/lib/api", () => ({
  workTaskGet: vi.fn().mockRejectedValue(new Error("not in this test")),
  workTaskComplete: (...args: unknown[]) => completeMock(...args),
  workTaskSettingsEffective: (...args: unknown[]) => settingsMock(...args),
}))

import { TaskCompleteDialog } from "./task-complete-dialog"

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

function settings(
  overrides?: Partial<WorkTaskFolderSettings>
): WorkTaskFolderSettings {
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
    ...overrides,
  }
}

function renderDialog(t: WorkTask = task()) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TaskCompleteDialog open onOpenChange={() => {}} task={t} />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  completeMock.mockClear()
  settingsMock.mockReset()
})

describe("TaskCompleteDialog", () => {
  it("takes the worktree with it when the folder default says so", async () => {
    settingsMock.mockResolvedValue(settings())
    renderDialog()

    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", { name: /Delete the worktree/ })
      ).toBeChecked()
    )
    await userEvent.click(screen.getByRole("button", { name: "Complete" }))
    await waitFor(() => expect(completeMock).toHaveBeenCalledWith(7, true))
  })

  it("keeps the worktree when the box is unchecked", async () => {
    settingsMock.mockResolvedValue(settings())
    renderDialog()

    const box = await screen.findByRole("checkbox", {
      name: /Delete the worktree/,
    })
    await waitFor(() => expect(box).toBeChecked())
    await userEvent.click(box)

    await userEvent.click(screen.getByRole("button", { name: "Complete" }))
    await waitFor(() => expect(completeMock).toHaveBeenCalledWith(7, false))
  })

  it("offers no worktree choice when there is no worktree left", async () => {
    settingsMock.mockResolvedValue(settings())
    renderDialog(task({ worktree_folder_id: null }))

    await waitFor(() => expect(settingsMock).toHaveBeenCalled())
    expect(screen.queryByRole("checkbox")).toBeNull()

    await userEvent.click(screen.getByRole("button", { name: "Complete" }))
    await waitFor(() => expect(completeMock).toHaveBeenCalledWith(7, false))
  })

  it("explains a gone worktree and completes without a deletion choice", async () => {
    settingsMock.mockResolvedValue(settings())
    // Recorded worktree, but its folder/directory no longer exists — the
    // engine converges the leftovers itself, so the checkbox disappears and
    // the copy switches to the no-merge-possible explanation.
    renderDialog(task({ files_changed: 3, worktree_missing: true }))

    await waitFor(() => expect(settingsMock).toHaveBeenCalled())
    expect(screen.queryByRole("checkbox")).toBeNull()
    expect(
      screen.getByText(/worktree has been removed/, { exact: false })
    ).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Complete" }))
    await waitFor(() => expect(completeMock).toHaveBeenCalledWith(7, false))
  })
})
