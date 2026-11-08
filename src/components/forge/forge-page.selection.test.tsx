/**
 * Picking several related issues and handing them to ONE task.
 *
 * What this file holds the page to: the selection survives everything that
 * only changes which part of the list is on screen (pages, filters, searches)
 * and goes with everything that changes WHICH list it is (the tab, the
 * folder); an issue with a live task can never be in it, and leaves it when
 * one appears; and what reaches the backend is the set that was picked, in
 * number order.
 */
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { buildForgeSourceKey } from "@/lib/forge-source-key"
import type {
  ForgeIssueList,
  ForgeIssueRow,
  ForgeRemote,
  ForgeTaskLink,
  WorkTask,
} from "@/lib/types"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import { useForgeRefreshStore } from "@/stores/forge-refresh-store"

const REMOTE: ForgeRemote = {
  server_host: "github.com",
  owner_repo: "acme/app",
  remote_url: "https://github.com/acme/app.git",
  web_origin: "https://github.com",
  provider: "github",
  supported: true,
}

vi.mock("@/lib/api", () => ({
  folderForgeRemote: vi.fn(),
  forgeListIssues: vi.fn(),
  forgeListLabels: vi.fn(),
  forgeTabCount: vi.fn(),
  forgeListComments: vi.fn(() => new Promise(() => {})),
  forgeChangeDetail: vi.fn(() => new Promise(() => {})),
  forgeChangeFiles: vi.fn(() => new Promise(() => {})),
  forgeIdentity: vi.fn(() => new Promise(() => {})),
  forgeCreateComment: vi.fn(),
  forgeSetItemState: vi.fn(),
  forgeCreateIssue: vi.fn(),
  openSettingsWindow: vi.fn().mockResolvedValue(undefined),
  workTaskLookupBySource: vi.fn().mockResolvedValue([]),
  workTaskCreateFromForge: vi.fn(),
  workTaskCreateFromForgeIssues: vi.fn(),
  forgeSettingsGet: vi.fn(),
  forgeSettingsSet: vi.fn(),
}))
/** The board's change events, captured so a test can fire one. */
const changeHandlers: Array<() => void> = []
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn((_event: string, handler: () => void) => {
    changeHandlers.push(handler)
    return Promise.resolve(() => {})
  }),
  openUrl: vi.fn(),
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
vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children?: string }) => (
    <div data-testid="markdown">{children}</div>
  ),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import {
  folderForgeRemote,
  forgeListIssues,
  forgeListLabels,
  forgeSettingsGet,
  forgeTabCount,
  workTaskCreateFromForgeIssues,
  workTaskLookupBySource,
} from "@/lib/api"
import { toast } from "sonner"

import { ForgePage } from "./forge-page"

function issue(number: number, isPr = false): ForgeIssueRow {
  return {
    number,
    title: `${isPr ? "change" : "issue"} ${number}`,
    body: `body ${number}`,
    state: "open",
    draft: false,
    labels: [{ name: "bug", color: null }],
    author: "alice",
    author_avatar: null,
    updated_at: null,
    html_url: `https://github.com/acme/app/${isPr ? "pull" : "issues"}/${number}`,
    is_pr: isPr,
    comments: 0,
  }
}

function listOf(
  rows: ForgeIssueRow[],
  overrides: Partial<ForgeIssueList> = {}
): ForgeIssueList {
  return {
    rows,
    page: 1,
    per_page: 20,
    total_count: rows.length,
    reachable_count: null,
    has_next: false,
    incomplete: false,
    ...overrides,
  }
}

function keyOf(number: number, kind: "issue" | "pr" = "issue"): string {
  return buildForgeSourceKey({
    provider: "github",
    serverHost: "github.com",
    ownerRepo: "acme/app",
    kind,
    number,
  })
}

function link(
  number: number,
  status: ForgeTaskLink["status"],
  items?: number[]
): ForgeTaskLink {
  return {
    source_key: keyOf(number),
    task_id: 100 + number,
    status,
    verdict: null,
    updated_at: "2026-11-06T00:00:00Z",
    items,
  }
}

/** Two pages: #3 and #5 on the first, #9 and #12 on the second; the pull
 *  request tab holds one change. */
function twoPages() {
  vi.mocked(forgeListIssues).mockImplementation(async (_folder, query) => {
    if (query.tab === "prs") return listOf([issue(40, true)])
    const page = query.page ?? 1
    return listOf(page === 1 ? [issue(3), issue(5)] : [issue(9), issue(12)], {
      page,
      per_page: 2,
      total_count: 4,
      has_next: page === 1,
    })
  })
}

function mount() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ForgePage />
    </NextIntlClientProvider>
  )
}

function box(number: number): HTMLElement {
  return screen.getByRole("checkbox", { name: `Select #${number}` })
}

function bar(): HTMLElement {
  return screen.getByRole("region", { name: "Selected issues" })
}

beforeEach(() => {
  vi.clearAllMocks()
  changeHandlers.length = 0
  resetAppWorkspaceStore()
  useForgeRefreshStore.setState({ refresh: null, busy: false })
  useAppWorkspaceStore.setState({
    folders: [
      { id: 1, name: "alpha-project", parent_id: null, kind: "regular" },
      { id: 2, name: "beta-project", parent_id: null, kind: "regular" },
    ] as never,
  })
  window.localStorage.clear()
  vi.mocked(folderForgeRemote).mockResolvedValue(REMOTE)
  vi.mocked(forgeTabCount).mockResolvedValue(1)
  vi.mocked(workTaskLookupBySource).mockResolvedValue([])
  vi.mocked(forgeListLabels).mockResolvedValue({ labels: [], truncated: false })
  vi.mocked(forgeSettingsGet).mockResolvedValue({
    global: {
      writeback_default: false,
      default_issue_scenario: "plan_first",
      scenario_prompts: {},
    },
    folders: {},
  })
  twoPages()
})

afterEach(() => {
  cleanup()
})

describe("ForgePage selection", () => {
  it("keeps picks across pages and hands them to one task, in number order", async () => {
    const user = userEvent.setup()
    mount()
    await screen.findByText("issue 3")

    await user.click(box(5))
    expect(within(bar()).getByText("1 selected")).toBeInTheDocument()
    // One issue is not a set: the action is there, and dead.
    expect(
      within(bar()).getByRole("button", { name: /Handle 1 together/ })
    ).toBeDisabled()

    await user.click(screen.getByRole("button", { name: "Go to page 2" }))
    await screen.findByText("issue 12")
    await user.click(box(12))
    expect(within(bar()).getByText("2 selected")).toBeInTheDocument()
    expect(within(bar()).getByText("1 not in this list")).toBeInTheDocument()
    // The pick that is off screen is still asked about, so its chip — and
    // whether it may stay picked — stays current.
    await waitFor(() => {
      const asked = vi.mocked(workTaskLookupBySource).mock.lastCall?.[0]
      expect(asked).toEqual([keyOf(9), keyOf(12), keyOf(5)])
    })

    const created = { id: 77, title: "#5 #12 · issue 5" } as WorkTask
    vi.mocked(workTaskCreateFromForgeIssues).mockResolvedValue({
      outcome: "created",
      task: created,
    })
    await user.click(
      within(bar()).getByRole("button", { name: /Handle 2 together/ })
    )
    const dialog = await screen.findByRole("dialog")
    expect(
      within(dialog).getByText("Handle 2 issues together")
    ).toBeInTheDocument()
    // The folder's own defaults: plan first, and silence.
    expect(
      within(dialog).getByRole("radio", { name: /Plan first/ })
    ).toBeChecked()
    expect(within(dialog).getByRole("switch")).not.toBeChecked()

    await user.click(
      within(dialog).getByRole("button", { name: "Create task" })
    )
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    const sent = vi.mocked(workTaskCreateFromForgeIssues).mock.calls[0][0]
    expect(sent.folder_id).toBe(1)
    expect(sent.source).toEqual({
      provider: "github",
      server_host: "github.com",
      owner_repo: "acme/app",
    })
    expect(sent.items.map((i) => i.number)).toEqual([5, 12])
    expect(sent.items[0].snapshot).toEqual({
      title: "issue 5",
      body: "body 5",
      labels: ["bug"],
      author: "alice",
    })
    expect(sent.scenario).toBe("plan_first")
    expect(sent.writeback).toBe(false)
    expect(sent.force).toBe(false)
    // Done with: the selection goes, the dialog closes.
    expect(screen.queryByRole("region", { name: "Selected issues" })).toBeNull()
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("keeps picks across a filter change", async () => {
    const user = userEvent.setup()
    mount()
    await screen.findByText("issue 3")
    await user.click(box(3))

    await user.click(screen.getByRole("combobox", { name: "State" }))
    await user.click(await screen.findByRole("option", { name: "Closed" }))
    await waitFor(() =>
      expect(vi.mocked(forgeListIssues).mock.lastCall?.[1].state).toBe("closed")
    )
    expect(within(bar()).getByText("1 selected")).toBeInTheDocument()
  })

  it("lets go of the picks when the tab or the folder changes", async () => {
    const user = userEvent.setup()
    mount()
    await screen.findByText("issue 3")
    await user.click(box(3))
    expect(bar()).toBeInTheDocument()

    await user.click(screen.getByRole("tab", { name: /Pull requests/ }))
    await screen.findByText("change 40")
    expect(screen.queryByRole("region", { name: "Selected issues" })).toBeNull()
    // Changes are never handled together: no boxes on that tab at all.
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0)

    await user.click(screen.getByRole("tab", { name: /Issues/ }))
    await screen.findByText("issue 3")
    expect(box(3)).not.toBeChecked()
    await user.click(box(3))

    await user.click(
      screen.getByRole("button", { name: /alpha-project/, expanded: false })
    )
    await user.click(
      await screen.findByRole("option", { name: /beta-project/ })
    )
    await screen.findByText("issue 3")
    expect(screen.queryByRole("region", { name: "Selected issues" })).toBeNull()
  })

  it("never picks an issue with a live task, and drops one that gains it", async () => {
    const user = userEvent.setup()
    vi.mocked(workTaskLookupBySource).mockResolvedValue([
      link(3, "running"),
      // Finished: handling it again is allowed, like "re-trigger".
      link(12, "done"),
    ])
    mount()
    await screen.findByText("issue 3")
    await waitFor(() => expect(box(3)).toBeDisabled())
    expect(box(3).closest("[title]")?.getAttribute("title")).toBe(
      "This issue already has a task under way"
    )
    expect(box(5)).toBeEnabled()

    await user.click(box(5))
    expect(bar()).toBeInTheDocument()
    // Elsewhere, a task starts on #5: the next board event's lookup says so.
    vi.mocked(workTaskLookupBySource).mockResolvedValue([
      link(3, "running"),
      link(5, "queued"),
    ])
    await act(async () => {
      for (const handler of changeHandlers) handler()
    })
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Selected issues" })
      ).toBeNull()
    )
    // …and it does not come back once that task is over.
    vi.mocked(workTaskLookupBySource).mockResolvedValue([link(5, "done")])
    await act(async () => {
      for (const handler of changeHandlers) handler()
    })
    await waitFor(() => expect(box(5)).toBeEnabled())
    expect(box(5)).not.toBeChecked()
  })

  it("ticks a range with Shift, and lets go of it all on Esc", async () => {
    const user = userEvent.setup()
    vi.mocked(forgeListIssues).mockResolvedValue(
      listOf([issue(1), issue(2), issue(3), issue(4)])
    )
    vi.mocked(workTaskLookupBySource).mockResolvedValue([link(3, "review")])
    mount()
    await screen.findByText("issue 1")
    await waitFor(() => expect(box(3)).toBeDisabled())

    await user.click(box(1))
    await user.keyboard("{Shift>}")
    await user.click(box(4))
    await user.keyboard("{/Shift}")
    // #3 is in the range but has a live task, so it stays out.
    expect(box(1)).toBeChecked()
    expect(box(2)).toBeChecked()
    expect(box(3)).not.toBeChecked()
    expect(box(4)).toBeChecked()

    // Esc on a box lets go of everything.
    expect(bar()).toBeInTheDocument()
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("region", { name: "Selected issues" })).toBeNull()
  })

  it("asks the lookup in batches once the keys outgrow one request", async () => {
    const user = userEvent.setup()
    window.localStorage.setItem("workspace:forge-page-size", "50")
    vi.mocked(forgeListIssues).mockImplementation(async (_folder, query) => {
      const page = query.page ?? 1
      const rows = Array.from({ length: 50 }, (_, i) =>
        issue((page - 1) * 50 + i + 1)
      )
      return listOf(rows, {
        page,
        per_page: 50,
        total_count: 150,
        has_next: page < 3,
      })
    })
    mount()
    await screen.findByText("issue 1")
    // Each page whole, as a Shift range from its first row to its last.
    const tickPage = async (first: number) => {
      await user.click(box(first))
      await user.keyboard("{Shift>}")
      await user.click(box(first + 49))
      await user.keyboard("{/Shift}")
    }
    await tickPage(1)
    await user.click(screen.getByRole("button", { name: "Go to page 2" }))
    await screen.findByText("issue 51")
    await tickPage(51)
    await user.click(screen.getByRole("button", { name: "Go to page 3" }))
    await screen.findByText("issue 101")

    // 50 on screen plus 100 picked elsewhere: two requests, none over 100.
    await waitFor(() => {
      const calls = vi.mocked(workTaskLookupBySource).mock.calls
      const last = calls.slice(-2).map((c) => c[0])
      expect(last.map((keys) => keys.length)).toEqual([100, 50])
      expect(new Set(last.flat()).size).toBe(150)
    })
  })

  it("says which other issues a chip's task handles", async () => {
    vi.mocked(workTaskLookupBySource).mockResolvedValue([
      link(3, "running", [3, 5, 9]),
      { ...link(5, "running", [3, 5, 9]), source_key: keyOf(5) },
    ])
    mount()
    await screen.findByText("issue 3")
    expect(
      await screen.findByText("Handled together with #5, #9")
    ).toBeInTheDocument()
    expect(screen.getByText("Handled together with #3, #9")).toBeInTheDocument()
  })
})
