/**
 * The repository panel embedded in the aux panel's Issues / Pull requests tab.
 *
 * It is the same list, locked to the host's project and tab — and it must stay
 * out of what belongs to the route's page: the window chrome's reload button
 * and settings gear, and the remembered folder and tab. Both copies can be
 * mounted at once (the aux panel stays mounted, collapsed, under the route), so
 * any of those leaking would hand the route's controls to a list nobody sees.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type {
  ForgeIssueList,
  ForgeIssueRow,
  ForgeRemote,
  ForgeTab,
} from "@/lib/types"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import { useForgeRefreshStore } from "@/stores/forge-refresh-store"

const REMOTE: ForgeRemote = {
  server_host: "github.com",
  owner_repo: "xintaofei/codeg",
  remote_url: "https://github.com/xintaofei/codeg.git",
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
  forgeSettingsGet: vi.fn(),
  forgeSettingsSet: vi.fn(),
}))
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn().mockResolvedValue(() => {}),
  openUrl: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({
    routeId: "conversations",
    isConversations: true,
    setRoute: vi.fn(),
    openConversations: vi.fn(),
  }),
}))
vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children?: string }) => (
    <div data-testid="markdown">{children}</div>
  ),
}))

import {
  folderForgeRemote,
  forgeListIssues,
  forgeListLabels,
  forgeSettingsGet,
  forgeTabCount,
} from "@/lib/api"
import { OPEN_FORGE_SETTINGS_EVENT } from "./forge-chrome-actions"
import { ForgePage, type ForgePageEmbed } from "./forge-page"

function issue(number: number, title: string, isPr = false): ForgeIssueRow {
  return {
    number,
    title,
    body: null,
    state: "open",
    draft: false,
    labels: [],
    author: "octocat",
    author_avatar: null,
    updated_at: null,
    html_url: `https://github.com/xintaofei/codeg/issues/${number}`,
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

function embedOf(overrides: Partial<ForgePageEmbed> = {}): ForgePageEmbed {
  return {
    folderId: 7,
    tab: "issues",
    active: true,
    onOpenFullPage: vi.fn(),
    ...overrides,
  }
}

function Host({ embed, page }: { embed?: ForgePageEmbed; page?: boolean }) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {page ? <ForgePage /> : null}
      {embed ? <ForgePage embed={embed} /> : null}
    </NextIntlClientProvider>
  )
}

/** The `query` half of each `forgeListIssues(folderId, query)` call. */
function sentQueries() {
  return vi.mocked(forgeListIssues).mock.calls
}

beforeEach(() => {
  vi.clearAllMocks()
  resetAppWorkspaceStore()
  useForgeRefreshStore.setState({ refresh: null, busy: false })
  // Folder 1 is the only project open in the sidebar; the panel is pointed at
  // folder 7 — a project root whose own row is closed (a worktree of it is the
  // active folder), which the embedded list must still serve.
  useAppWorkspaceStore.setState({
    folders: [
      { id: 1, name: "codeg", parent_id: null, kind: "regular" },
    ] as never,
  })
  window.localStorage.clear()
  vi.mocked(folderForgeRemote).mockResolvedValue(REMOTE)
  vi.mocked(forgeTabCount).mockResolvedValue(3)
  vi.mocked(forgeListLabels).mockResolvedValue({ labels: [], truncated: false })
  vi.mocked(forgeSettingsGet).mockResolvedValue({
    global: { writeback_default: true, scenario_prompts: {} },
    folders: {},
  })
  vi.mocked(forgeListIssues).mockResolvedValue(
    listOf([issue(42, "Login times out")])
  )
})

describe("ForgePage embedded in the aux panel", () => {
  it("lists the host's folder and tab, with no picker and no switcher", async () => {
    vi.mocked(forgeListIssues).mockResolvedValue(
      listOf([issue(9, "Bump the toolchain", true)])
    )
    render(<Host embed={embedOf({ tab: "prs" as ForgeTab })} />)

    expect(await screen.findByText("Bump the toolchain")).toBeInTheDocument()
    expect(folderForgeRemote).toHaveBeenCalledWith(7)
    const [folderId, query] = sentQueries()[0]
    expect(folderId).toBe(7)
    expect(query.tab).toBe("prs")
    // Neither of the full page's two choosers.
    expect(screen.queryByRole("tab")).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /Select a project folder/ })
    ).not.toBeInTheDocument()
    // The repository is still named — and is the way out to the forge.
    expect(
      screen.getByRole("button", { name: /xintaofei\/codeg/ })
    ).toBeInTheDocument()
  })

  it("spends no request on a badge for a tab it does not have", async () => {
    render(<Host embed={embedOf()} />)
    await screen.findByText("Login times out")
    expect(forgeTabCount).not.toHaveBeenCalled()
  })

  it("leaves the window chrome's reload and settings to the route's page", async () => {
    const { rerender } = render(<Host page embed={embedOf()} />)
    await screen.findAllByText("Login times out")
    await waitFor(() =>
      expect(useForgeRefreshStore.getState().refresh).not.toBeNull()
    )

    // Unmounting the panel's copy must not take the route's button with it.
    rerender(<Host page />)
    expect(useForgeRefreshStore.getState().refresh).not.toBeNull()

    // And the gear opens ONE settings dialog — the route page's.
    rerender(<Host page embed={embedOf()} />)
    await screen.findAllByText("Login times out")
    act(() => {
      window.dispatchEvent(new Event(OPEN_FORGE_SETTINGS_EVENT))
    })
    expect(await screen.findAllByRole("dialog")).toHaveLength(1)
  })

  it("publishes nothing to the chrome when it is the only copy", async () => {
    render(<Host embed={embedOf()} />)
    await screen.findByText("Login times out")
    expect(useForgeRefreshStore.getState().refresh).toBeNull()
    act(() => {
      window.dispatchEvent(new Event(OPEN_FORGE_SETTINGS_EVENT))
    })
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("does not touch the full page's remembered folder or tab", async () => {
    render(<Host embed={embedOf({ tab: "prs" as ForgeTab })} />)
    await screen.findByText("Login times out")
    expect(window.localStorage.getItem("forge:folderId")).toBeNull()
    expect(window.localStorage.getItem("workspace:forge-tab")).toBeNull()
  })

  it("asks for nothing while hidden, and reloads once when shown again", async () => {
    const embed = embedOf()
    const { rerender } = render(<Host embed={embed} />)
    await screen.findByText("Login times out")
    const before = sentQueries().length

    rerender(<Host embed={{ ...embed, active: false }} />)
    rerender(<Host embed={{ ...embed, active: false }} />)
    expect(sentQueries().length).toBe(before)

    rerender(<Host embed={{ ...embed, active: true }} />)
    await waitFor(() => expect(sentQueries().length).toBe(before + 1))
    expect(sentQueries()[before]).toEqual(sentQueries()[0])
    // Staying on screen asks for nothing more.
    rerender(<Host embed={{ ...embed, active: true }} />)
    expect(sentQueries().length).toBe(before + 1)
  })

  it("stays quiet when hidden before its remote resolves", async () => {
    let resolveRemote: (r: ForgeRemote) => void = () => {}
    vi.mocked(folderForgeRemote).mockImplementation(
      () => new Promise((resolve) => (resolveRemote = resolve))
    )
    const embed = embedOf()
    const { rerender } = render(<Host embed={embed} />)
    rerender(<Host embed={{ ...embed, active: false }} />)
    await act(async () => resolveRemote(REMOTE))
    expect(sentQueries()).toHaveLength(0)

    rerender(<Host embed={{ ...embed, active: true }} />)
    expect(await screen.findByText("Login times out")).toBeInTheDocument()
    expect(sentQueries()).toHaveLength(1)
  })

  it("holds a search that settles while hidden until it is shown", async () => {
    const embed = embedOf()
    const { rerender } = render(<Host embed={embed} />)
    await screen.findByText("Login times out")
    const before = sentQueries().length

    fireEvent.change(screen.getByRole("textbox", { name: /Search/ }), {
      target: { value: "timeout" },
    })
    rerender(<Host embed={{ ...embed, active: false }} />)
    // Past the search debounce: the search has settled, behind the hidden tab.
    await act(() => new Promise((r) => setTimeout(r, 450)))
    expect(sentQueries().length).toBe(before)

    rerender(<Host embed={{ ...embed, active: true }} />)
    await waitFor(() => expect(sentQueries().length).toBe(before + 1))
    expect(sentQueries()[before][1].search).toBe("timeout")
  })

  it("offers a new issue on the issue tab only, plus reload and the full page", async () => {
    const user = userEvent.setup()
    const embed = embedOf()
    const { rerender } = render(<Host embed={embed} />)
    await screen.findByText("Login times out")

    expect(screen.getByRole("button", { name: "New issue" })).toBeEnabled()
    await user.click(screen.getByRole("button", { name: "Open full page" }))
    expect(embed.onOpenFullPage).toHaveBeenCalledTimes(1)

    const before = sentQueries().length
    await user.click(screen.getByRole("button", { name: "Refresh" }))
    await waitFor(() => expect(sentQueries().length).toBe(before + 1))

    rerender(<Host embed={{ ...embed, tab: "prs" as ForgeTab }} />)
    expect(
      screen.queryByRole("button", { name: "New issue" })
    ).not.toBeInTheDocument()
  })

  it("pages with a compact pager, and shows none for a single page", async () => {
    const user = userEvent.setup()
    vi.mocked(forgeListIssues).mockImplementation(async (_folder, query) =>
      listOf([issue(query.page ?? 1, `Row on page ${query.page}`)], {
        page: query.page ?? 1,
        total_count: 60,
        has_next: (query.page ?? 1) < 3,
      })
    )
    const { unmount } = render(<Host embed={embedOf()} />)
    expect(await screen.findByText("Row on page 1")).toBeInTheDocument()
    expect(screen.getByText("1 / 3")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Next page" }))
    expect(await screen.findByText("Row on page 2")).toBeInTheDocument()
    expect(screen.getByText("2 / 3")).toBeInTheDocument()
    unmount()

    vi.mocked(forgeListIssues).mockResolvedValue(
      listOf([issue(42, "Login times out")])
    )
    render(<Host embed={embedOf()} />)
    await screen.findByText("Login times out")
    expect(screen.queryByTestId("forge-footer")).not.toBeInTheDocument()
  })
})
