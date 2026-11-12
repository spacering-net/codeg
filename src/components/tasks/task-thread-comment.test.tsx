import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import type { ForgeSourceMeta, WorkTask } from "@/lib/types"

const calls: string[] = []
const completeMock = vi.fn(async () => {
  calls.push("complete")
})
const setWritebackMock = vi.fn(async () => {
  calls.push("set_writeback")
})

vi.mock("@/lib/api", () => ({
  workTaskComplete: (...args: unknown[]) => completeMock(...(args as [])),
  workTaskSetWriteback: (...args: unknown[]) =>
    setWritebackMock(...(args as [])),
  workTaskSettingsEffective: () =>
    Promise.resolve({ delete_worktree_default: false }),
}))

import { TaskCompleteDialog } from "./task-complete-dialog"

function meta(overrides?: Partial<ForgeSourceMeta>): ForgeSourceMeta {
  return {
    provider: "github",
    server_host: "github.com",
    api_base: "https://api.github.com",
    account_id: "acc-1",
    owner_repo: "acme/app",
    number: 7,
    url: "https://github.com/acme/app/issues/7",
    title: "Login breaks",
    writeback: true,
    ...overrides,
  } as ForgeSourceMeta
}

function task(overrides?: Partial<WorkTask>): WorkTask {
  return {
    id: 5,
    folder_id: 1,
    title: "#7 · Login breaks",
    config: null,
    status: "review",
    failure_reason: null,
    last_error: null,
    run_seq: 1,
    sort_order: 1,
    worktree_folder_id: null,
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
    source_kind: "forge_issue",
    source_meta: meta(),
    writeback_drafts: { "7": "Does not reproduce on main." },
    ...overrides,
  }
}

function renderDialog(t: WorkTask) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TaskCompleteDialog open onOpenChange={() => {}} task={t} />
    </NextIntlClientProvider>
  )
}

const submit = () =>
  userEvent.click(screen.getByRole("button", { name: "Complete" }))

beforeEach(() => {
  calls.length = 0
  completeMock.mockClear()
  setWritebackMock.mockClear()
})

describe("thread comment in the acceptance dialog", () => {
  it("is neither offered nor sent for a task without a thread", async () => {
    renderDialog(
      task({ source_kind: null, source_meta: null, writeback_drafts: null })
    )
    expect(screen.queryByRole("checkbox")).toBeNull()
    await submit()
    await waitFor(() => expect(completeMock).toHaveBeenCalled())
    expect(setWritebackMock).not.toHaveBeenCalled()
  })

  it("shows the agent's draft and binds even an untouched answer to its run", async () => {
    renderDialog(task({ run_seq: 4 }))
    expect(
      await screen.findByRole("checkbox", { name: /Comment in the item/ })
    ).toBeChecked()
    expect(screen.getByLabelText("Reply for #7")).toHaveValue(
      "Does not reproduce on main."
    )
    await submit()
    await waitFor(() => expect(completeMock).toHaveBeenCalled())
    // Sent unchanged all the same: it names the run whose reply was shown,
    // so a task that ran again meanwhile refuses the acceptance.
    expect(setWritebackMock).toHaveBeenCalledWith(5, 4, true, {
      7: "Does not reproduce on main.",
    })
    expect(calls).toEqual(["set_writeback", "complete"])
  })

  it("stores an edited reply before accepting", async () => {
    renderDialog(task())
    const box = await screen.findByLabelText("Reply for #7")
    await userEvent.clear(box)
    await userEvent.type(box, "Fixed in the next release.")
    await submit()
    await waitFor(() => expect(completeMock).toHaveBeenCalled())
    expect(setWritebackMock).toHaveBeenCalledWith(5, 1, true, {
      7: "Fixed in the next release.",
    })
    expect(calls).toEqual(["set_writeback", "complete"])
  })

  it("can switch the comment off, keeping the draft", async () => {
    renderDialog(task())
    await userEvent.click(
      await screen.findByRole("checkbox", { name: /Comment in the item/ })
    )
    expect(screen.queryByLabelText("Reply for #7")).toBeNull()
    await submit()
    await waitFor(() => expect(completeMock).toHaveBeenCalled())
    expect(setWritebackMock).toHaveBeenCalledWith(5, 1, false, {
      7: "Does not reproduce on main.",
    })
  })

  it("asks for each issue of a task of several", async () => {
    renderDialog(
      task({
        source_meta: meta({
          items: [
            { number: 7, url: "u7", title: "a" },
            { number: 9, url: "u9", title: "b" },
          ],
          writeback: false,
        }),
      })
    )
    const box = await screen.findByRole("checkbox", {
      name: /each issue's thread/,
    })
    expect(box).not.toBeChecked()
    await userEvent.click(box)
    await userEvent.type(screen.getByLabelText("Reply for #9"), "Same cause.")
    await submit()
    await waitFor(() => expect(completeMock).toHaveBeenCalled())
    expect(setWritebackMock).toHaveBeenCalledWith(5, 1, true, {
      7: "Does not reproduce on main.",
      9: "Same cause.",
    })
  })

  it("does not accept when the answer could not be stored", async () => {
    setWritebackMock.mockRejectedValueOnce(new Error("moved on"))
    renderDialog(task())
    await screen.findByRole("checkbox", { name: /Comment in the item/ })
    await submit()
    await waitFor(() => expect(setWritebackMock).toHaveBeenCalled())
    expect(completeMock).not.toHaveBeenCalled()
  })
})
