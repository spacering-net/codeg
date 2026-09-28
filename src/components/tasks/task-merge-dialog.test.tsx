import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import type { WorkTask, WorkTaskFolderSettings } from "@/lib/types"

const mergeMock = vi.fn().mockResolvedValue(false)
const settingsMock = vi.fn()
const toastSuccess = vi.fn()

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: vi.fn(),
  },
}))

vi.mock("@/lib/api", () => ({
  workTaskMerge: (...args: unknown[]) => mergeMock(...args),
  workTaskSettingsEffective: (...args: unknown[]) => settingsMock(...args),
}))

import { TaskMergeDialog } from "./task-merge-dialog"

function task(): WorkTask {
  return {
    id: 7,
    folder_id: 1,
    title: "Fix login",
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
    files_changed: 2,
    additions: 10,
    deletions: 3,
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

function renderDialog(props?: {
  anotherMerging?: boolean
  alreadyQueued?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TaskMergeDialog
        open
        onOpenChange={props?.onOpenChange ?? (() => {})}
        task={task()}
        anotherMerging={props?.anotherMerging}
        alreadyQueued={props?.alreadyQueued}
      />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  mergeMock.mockReset()
  mergeMock.mockResolvedValue(false)
  settingsMock.mockReset()
  toastSuccess.mockClear()
})

describe("TaskMergeDialog", () => {
  it("defaults to an agent-written message and passes null on submit", async () => {
    settingsMock.mockResolvedValue(settings())
    renderDialog()

    // Auto-message on by default → no textarea, message goes out as null.
    expect(
      screen.getByRole("checkbox", { name: /write the commit message/ })
    ).toBeChecked()
    expect(screen.queryByLabelText("Commit message")).toBeNull()
    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", { name: /Delete worktree after merge/ })
      ).toBeChecked()
    )

    await userEvent.click(screen.getByRole("button", { name: "Merge" }))
    await waitFor(() =>
      expect(mergeMock).toHaveBeenCalledWith(7, null, true, null)
    )
  })

  it("unchecking auto reveals the title-prefilled message and sends it", async () => {
    settingsMock.mockResolvedValue(settings({ delete_worktree_default: false }))
    renderDialog()

    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", { name: /Delete worktree after merge/ })
      ).not.toBeChecked()
    )
    await userEvent.click(
      screen.getByRole("checkbox", { name: /write the commit message/ })
    )
    const message = await screen.findByLabelText("Commit message")
    expect((message as HTMLTextAreaElement).value).toBe("Fix login")

    await userEvent.click(screen.getByRole("button", { name: "Merge" }))
    await waitFor(() =>
      expect(mergeMock).toHaveBeenCalledWith(7, "Fix login", false, null)
    )
  })

  // Optional in both directions: typing goes through verbatim, and leaving it
  // alone must not start gating the button the way the commit message does.
  it("sends extra instructions when typed, and never blocks on them", async () => {
    settingsMock.mockResolvedValue(settings())
    renderDialog()

    const extra = await screen.findByLabelText(/Extra instructions/)
    expect((extra as HTMLTextAreaElement).value).toBe("")
    expect(screen.getByRole("button", { name: "Merge" })).toBeEnabled()

    await userEvent.type(extra, "  prefer ours on conflict  ")
    await userEvent.click(screen.getByRole("button", { name: "Merge" }))
    await waitFor(() =>
      expect(mergeMock).toHaveBeenCalledWith(
        7,
        null,
        true,
        "prefer ours on conflict"
      )
    )
  })

  it("refuses to submit a manual empty message", async () => {
    settingsMock.mockResolvedValue(settings())
    renderDialog()

    await userEvent.click(
      screen.getByRole("checkbox", { name: /write the commit message/ })
    )
    const message = await screen.findByLabelText("Commit message")
    await userEvent.clear(message)
    expect(screen.getByRole("button", { name: "Merge" })).toBeDisabled()
    expect(mergeMock).not.toHaveBeenCalled()
  })

  // The bug this replaced: a refusal went out as a toast, which paints UNDER
  // the open dialog — so the button looked dead. The reason has to be in the
  // dialog, and the dialog has to stay open to show it.
  it("shows a refusal inside the dialog and keeps it open", async () => {
    settingsMock.mockResolvedValue(settings())
    mergeMock.mockRejectedValue(new Error("project folder is on 'feature'"))
    const onOpenChange = vi.fn()
    renderDialog({ onOpenChange })

    await userEvent.click(screen.getByRole("button", { name: "Merge" }))
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("project folder is on 'feature'")
    expect(onOpenChange).not.toHaveBeenCalled()
    // And it stays submittable — the user fixes the branch and retries.
    expect(screen.getByRole("button", { name: "Merge" })).toBeEnabled()
  })

  it("promises a queue while the project is landing another task", async () => {
    settingsMock.mockResolvedValue(settings())
    mergeMock.mockResolvedValue(true)
    const onOpenChange = vi.fn()
    renderDialog({ anotherMerging: true, onOpenChange })

    expect(screen.getByText(/joins the queue/)).toBeInTheDocument()
    await userEvent.click(
      screen.getByRole("button", { name: "Add to merge queue" })
    )
    await waitFor(() =>
      expect(mergeMock).toHaveBeenCalledWith(7, null, true, null)
    )
    // Closed, and the queued outcome is announced where it can be read.
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(toastSuccess).toHaveBeenCalledTimes(1)
  })

  it("says nothing extra when the merge starts right away", async () => {
    settingsMock.mockResolvedValue(settings())
    renderDialog()

    await userEvent.click(screen.getByRole("button", { name: "Merge" }))
    await waitFor(() => expect(mergeMock).toHaveBeenCalled())
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  // The reported bug: a plain merge flashed "this project is landing another
  // task" for the seconds its dispatch took. The engine broadcasts
  // review→merging as soon as it begins — before the call returns — so the
  // board recomputes and the still-open dialog gets told its own project is
  // busy. What the button promised when it was pressed has to hold until the
  // call answers.
  it("keeps its promise while the dispatch is in flight", async () => {
    settingsMock.mockResolvedValue(settings())
    let settle: (queued: boolean) => void = () => {}
    mergeMock.mockReturnValue(
      new Promise<boolean>((resolve) => {
        settle = resolve
      })
    )
    const onOpenChange = vi.fn()
    const view = (anotherMerging: boolean) => (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <TaskMergeDialog
          open
          onOpenChange={onOpenChange}
          task={task()}
          anotherMerging={anotherMerging}
        />
      </NextIntlClientProvider>
    )
    const { rerender } = render(view(false))

    await userEvent.click(screen.getByRole("button", { name: "Merge" }))
    await waitFor(() => expect(mergeMock).toHaveBeenCalled())

    rerender(view(true))
    expect(screen.queryByText(/joins the queue/)).toBeNull()
    // The button says what it is doing rather than going quietly disabled: the
    // dispatch is short but not instant (it waits for the agent to come up).
    expect(
      screen.getByRole("button", { name: "Starting…" })
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /queue/ })).toBeNull()

    // And the dispatch still lands as a dispatch.
    settle(false)
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it("keeps what the user typed when the board refetches under it", async () => {
    settingsMock.mockResolvedValue(settings())
    const { rerender } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <TaskMergeDialog open onOpenChange={() => {}} task={task()} />
      </NextIntlClientProvider>
    )

    await userEvent.click(
      screen.getByRole("checkbox", { name: /write the commit message/ })
    )
    const message = await screen.findByLabelText("Commit message")
    await userEvent.clear(message)
    await userEvent.type(message, "fix: the login redirect")

    // `task://changed` lands: same row, brand new object.
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <TaskMergeDialog open onOpenChange={() => {}} task={task()} />
      </NextIntlClientProvider>
    )

    const after = (await screen.findByLabelText(
      "Commit message"
    )) as HTMLTextAreaElement
    expect(after.value).toBe("fix: the login redirect")
  })

  // Reopening a queued task shows the merge it has PARKED. Seeding the
  // defaults instead would silently replace the commit message and worktree
  // choice the user queued with, on a screen that says it only "updates" it.
  it("opens a queued task on the options it was queued with", async () => {
    settingsMock.mockResolvedValue(settings({ delete_worktree_default: true }))
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <TaskMergeDialog
          open
          onOpenChange={() => {}}
          task={{
            ...task(),
            merge_queued: {
              message: "fix: the login redirect",
              delete_worktree: false,
              instructions: "prefer ours on conflict",
              queued_at: "2026-08-01T00:30:00Z",
            },
          }}
          alreadyQueued
        />
      </NextIntlClientProvider>
    )

    const message = (await screen.findByLabelText(
      "Commit message"
    )) as HTMLTextAreaElement
    expect(message.value).toBe("fix: the login redirect")
    expect(
      screen.getByRole("checkbox", { name: /write the commit message/ })
    ).not.toBeChecked()
    // The parked choice wins over the folder default, which says the opposite.
    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", { name: /Delete worktree after merge/ })
      ).not.toBeChecked()
    )
    expect(
      (screen.getByLabelText(/Extra instructions/) as HTMLTextAreaElement).value
    ).toBe("prefer ours on conflict")

    // Submitting re-sends exactly what is on screen.
    mergeMock.mockResolvedValue(true)
    await userEvent.click(
      screen.getByRole("button", { name: "Add to merge queue" })
    )
    await waitFor(() =>
      expect(mergeMock).toHaveBeenCalledWith(
        7,
        "fix: the login redirect",
        false,
        "prefer ours on conflict"
      )
    )
  })

  it("frames a re-submit of an already queued task as an edit", () => {
    settingsMock.mockResolvedValue(settings())
    renderDialog({ alreadyQueued: true })

    expect(screen.getByText(/keeps its place in the queue/)).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Add to merge queue" })
    ).toBeInTheDocument()
  })
})
