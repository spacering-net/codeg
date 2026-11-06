/**
 * The combine dialog: several issues, ONE task. What it sends is the set it
 * was opened with minus whatever was taken out of it; a dedup hit names every
 * issue a live task already holds and offers to drop exactly those; and the
 * dialog never submits a "set" of one.
 */
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type {
  ForgeIssueRow,
  ForgeIssuesCreateResult,
  ForgeRemote,
  WorkTask,
} from "@/lib/types"

import { ForgeCombineDialog } from "./forge-combine-dialog"

const workTaskCreateFromForgeIssues = vi.fn()
vi.mock("@/lib/api", () => ({
  workTaskCreateFromForgeIssues: (...args: unknown[]) =>
    workTaskCreateFromForgeIssues(...args),
}))
const setRoute = vi.fn()
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({
    routeId: "forge",
    isConversations: false,
    setRoute,
    openConversations: vi.fn(),
  }),
}))

const REMOTE: ForgeRemote = {
  server_host: "github.com",
  owner_repo: "acme/app",
  remote_url: "https://github.com/acme/app.git",
  provider: "github",
  supported: true,
}

function issue(number: number): ForgeIssueRow {
  return {
    number,
    title: `issue ${number}`,
    body: `body ${number}`,
    state: "open",
    draft: false,
    labels: [],
    author: "alice",
    author_avatar: null,
    updated_at: null,
    html_url: `https://github.com/acme/app/issues/${number}`,
    is_pr: false,
    comments: 0,
  }
}

function task(id: number, title: string, status = "running"): WorkTask {
  return { id, title, status } as unknown as WorkTask
}

function mount(items: ForgeIssueRow[], onCreated = vi.fn(), onClose = vi.fn()) {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ForgeCombineDialog
        items={items}
        remote={REMOTE}
        folderId={1}
        settings={null}
        onClose={onClose}
        onCreated={onCreated}
      />
    </NextIntlClientProvider>
  )
  return { onCreated, onClose }
}

function sentNumbers(call = 0): number[] {
  const draft = workTaskCreateFromForgeIssues.mock.calls[call][0] as {
    items: { number: number }[]
  }
  return draft.items.map((i) => i.number)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("ForgeCombineDialog", () => {
  it("lists the set in number order and sends it with the built-in defaults", async () => {
    const user = userEvent.setup()
    const created = task(9, "#3 #5 #9 · issue 3", "todo")
    workTaskCreateFromForgeIssues.mockResolvedValue({
      outcome: "created",
      task: created,
    } satisfies ForgeIssuesCreateResult)
    const { onCreated } = mount([issue(9), issue(3), issue(5)])

    const list = screen.getByRole("list", { name: "Issues in this task" })
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.textContent)
    ).toEqual(["#3issue 3", "#5issue 5", "#9issue 9"])
    // No settings yet: fix, and the write-back switch on.
    expect(
      screen.getByRole("radio", { name: /Fix \/ implement/ })
    ).toBeChecked()
    expect(screen.getByRole("switch")).toBeChecked()

    await user.type(
      screen.getByRole("textbox", { name: /Optional extra instruction/ }),
      "  mind the docs  "
    )
    await user.click(screen.getByRole("button", { name: "Create task" }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created, 3))
    const draft = workTaskCreateFromForgeIssues.mock.calls[0][0]
    expect(sentNumbers()).toEqual([3, 5, 9])
    expect(draft).toMatchObject({
      folder_id: 1,
      scenario: "fix",
      instruction: "mind the docs",
      writeback: true,
      force: false,
    })
  })

  it("answers a dedup hit with every collision, and can drop exactly those", async () => {
    const user = userEvent.setup()
    workTaskCreateFromForgeIssues
      .mockResolvedValueOnce({
        outcome: "duplicate",
        conflicts: [{ number: 5, existing: task(40, "#5 · issue 5") }],
      } satisfies ForgeIssuesCreateResult)
      .mockResolvedValueOnce({
        outcome: "created",
        task: task(41, "#3 #9 · issue 3", "todo"),
      } satisfies ForgeIssuesCreateResult)
    const { onCreated } = mount([issue(3), issue(5), issue(9)])

    await user.click(screen.getByRole("button", { name: "Create task" }))
    expect(
      await screen.findByText("#5 — #5 · issue 5 (Running)")
    ).toBeInTheDocument()

    await user.click(
      screen.getByRole("button", { name: "Remove these issues" })
    )
    // Back to the form, without #5.
    expect(screen.queryByText("issue 5")).toBeNull()
    await user.click(screen.getByRole("button", { name: "Create task" }))
    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    expect(sentNumbers(1)).toEqual([3, 9])
  })

  it("can create anyway, or go and look at the task that holds them", async () => {
    const user = userEvent.setup()
    workTaskCreateFromForgeIssues.mockResolvedValue({
      outcome: "duplicate",
      conflicts: [
        { number: 3, existing: task(40, "#3 · issue 3") },
        { number: 5, existing: task(40, "#3 · issue 3") },
      ],
    } satisfies ForgeIssuesCreateResult)
    const { onClose } = mount([issue(3), issue(5)])

    await user.click(screen.getByRole("button", { name: "Create task" }))
    await screen.findByText("Active tasks already handle some of these issues:")
    await user.click(screen.getByRole("button", { name: "Create anyway" }))
    await waitFor(() =>
      expect(workTaskCreateFromForgeIssues).toHaveBeenCalledTimes(2)
    )
    expect(workTaskCreateFromForgeIssues.mock.calls[1][0]).toMatchObject({
      force: true,
    })

    await user.click(
      screen.getByRole("button", { name: "View the existing task" })
    )
    expect(onClose).toHaveBeenCalled()
    expect(setRoute).toHaveBeenCalledWith("tasks")
  })

  it("never submits a set of one", async () => {
    const user = userEvent.setup()
    mount([issue(3), issue(5)])
    await user.click(screen.getByRole("button", { name: "Remove #5" }))
    expect(screen.getByRole("button", { name: "Create task" })).toBeDisabled()
    expect(
      screen.getByText(/Handling issues together takes at least two/)
    ).toBeInTheDocument()
    expect(workTaskCreateFromForgeIssues).not.toHaveBeenCalled()
  })

  it("names the folder's actual remote when it is not this repository", async () => {
    const user = userEvent.setup()
    workTaskCreateFromForgeIssues.mockResolvedValue({
      outcome: "folder_mismatch",
      folder_remote: { ...REMOTE, owner_repo: "acme/fork" },
    } satisfies ForgeIssuesCreateResult)
    mount([issue(3), issue(5)])
    await user.click(screen.getByRole("button", { name: "Create task" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "github.com/acme/fork"
    )
  })
})
