/**
 * What the workbench does when the LIST fails.
 *
 * The regression this file exists for: a rejected `invoke()` hands back the
 * backend's `AppCommandError` as a PLAIN OBJECT, not an `Error`. The page used
 * to fall back to `String(e)` on it, which renders the literal text
 * "[object Object]" — and since both tabs share one fetch path, that was the
 * entire page for both Issues and PRs.
 *
 * The second rule here is that only ONE failure earns the "add an account"
 * button: the host having no account at all. A dead token or a stale pinned
 * account id land in the same code, and pointing those at the add-account flow
 * would be advice that cannot work.
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
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { forgeListIssues, openSettingsWindow } from "@/lib/api"
import { buildForgeSourceKey } from "@/lib/forge-source-key"
import type {
  ForgeComment,
  ForgeIssueList,
  ForgeIssueRow,
  ForgeRemote,
  ForgeTab,
  ForgeTaskLink,
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
  // The detail panel fetches the item's discussion as soon as it opens. Left
  // in flight here: every assertion below is about the LIST or the panel's own
  // wiring, and a request that resolved would land its state update after the
  // test that opened the panel had finished. The thread itself is covered in
  // `forge-issue-detail-sheet.test.tsx`.
  forgeListComments: vi.fn(() => new Promise(() => {})),
  // Same reason: a pull request's panel asks for its branches and its file
  // list the moment it opens. Covered in the panel's own suite.
  forgeChangeDetail: vi.fn(() => new Promise(() => {})),
  forgeChangeFiles: vi.fn(() => new Promise(() => {})),
  // And the composer's "posting as" lookup, fired by every panel that opens
  // with a folder. Same reason again — it moves one avatar, and nothing here
  // is about the avatar.
  forgeIdentity: vi.fn(() => new Promise(() => {})),
  forgeCreateComment: vi.fn(),
  forgeSetItemState: vi.fn(),
  forgeCreateIssue: vi.fn(),
  openSettingsWindow: vi.fn().mockResolvedValue(undefined),
  workTaskLookupBySource: vi.fn().mockResolvedValue([]),
  workTaskCreateFromForge: vi.fn(),
  // Read once on mount for the trigger dialog's starting positions. Resolved,
  // never rejected, in the default fixture: every assertion below is about the
  // LIST, and a rejected preferences read would add an unhandled rejection to
  // each of them.
  forgeSettingsGet: vi.fn(),
  forgeSettingsSet: vi.fn(),
}))
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn().mockResolvedValue(() => {}),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({
    routeId: "forge",
    isConversations: false,
    setRoute: vi.fn(),
    openConversations: vi.fn(),
  }),
}))
// The detail panel's Markdown renderer. The real one reaches the workspace
// context (link safety routes file links into the file panel), which this page
// is mounted outside of; the stub still reports what it was handed, so the
// assertions below are about the panel's own wiring rather than about
// Streamdown.
vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children?: string }) => (
    <div data-testid="markdown">{children}</div>
  ),
}))

import {
  folderForgeRemote,
  forgeCreateComment,
  forgeCreateIssue,
  forgeListComments,
  forgeListLabels,
  forgeSetItemState,
  forgeSettingsGet,
  forgeTabCount,
  workTaskLookupBySource,
} from "@/lib/api"

import { ForgeChromeActions } from "./forge-chrome-actions"
import { ForgePage, repoWebUrl } from "./forge-page"

/** The `query` half of the last `forgeListIssues(folderId, query)` call. */
type SentQuery = Parameters<typeof forgeListIssues>[1]

function sentQueries(): SentQuery[] {
  return vi.mocked(forgeListIssues).mock.calls.map((call) => call[1])
}

function lastQuery(): SentQuery {
  const all = sentQueries()
  return all[all.length - 1]
}

/** The wire shape of a rejected Tauri command: `AppCommandError` after serde. */
function backendError(fields: {
  code: string
  message: string
  detail?: string
  i18n_key?: string
  i18n_params?: Record<string, string>
}) {
  return { ...fields }
}

function issue(number: number, title: string): ForgeIssueRow {
  return {
    number,
    title,
    body: null,
    state: "open",
    draft: false,
    labels: [],
    author: "octocat",
    author_avatar: "https://avatars.githubusercontent.com/u/583231",
    updated_at: null,
    html_url: `https://github.com/xintaofei/codeg/issues/${number}`,
    is_pr: false,
    comments: 0,
  }
}

/** One page as the backend serializes it, with a single-page default. */
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

/**
 * The page AND the window-chrome cluster that hosts its reload button. In the
 * real shell those are two different branches of the tree — the button is
 * rendered next to the settings gear, and only reaches the page's fetch through
 * `useForgeRefreshStore`. Rendering both is what keeps that wiring under test.
 */
function Shell({ page = true }: { page?: boolean }) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ForgeChromeActions buttonClassName="h-6 w-6" iconClassName="size-3.5" />
      {page ? <ForgePage /> : null}
    </NextIntlClientProvider>
  )
}

function mount() {
  return render(<Shell />)
}

beforeEach(() => {
  vi.clearAllMocks()
  resetAppWorkspaceStore()
  // Module-scoped: a page from the previous test would otherwise leave its
  // handler behind for the next one's chrome button.
  useForgeRefreshStore.setState({ refresh: null, busy: false })
  useAppWorkspaceStore.setState({
    folders: [
      { id: 1, name: "codeg", parent_id: null, kind: "regular" },
    ] as never,
  })
  window.localStorage.clear()
  vi.mocked(folderForgeRemote).mockResolvedValue(REMOTE)
  // The page only ever probes the tab it is NOT showing; it opens on
  // Issues, so this is the pull-request badge.
  vi.mocked(forgeTabCount).mockResolvedValue(3)
  vi.mocked(workTaskLookupBySource).mockResolvedValue([])
  vi.mocked(forgeListLabels).mockResolvedValue({
    labels: [
      { name: "bug", color: "#d73a4a" },
      // No colour the forge could normalize — the filter still has to list it.
      { name: "help wanted", color: null },
    ],
    truncated: false,
  })
  vi.mocked(forgeSettingsGet).mockResolvedValue({
    global: { writeback_default: true, scenario_prompts: {} },
    folders: {},
  })
})

describe("ForgePage list failures", () => {
  it("renders the backend error's text, never the object's toString", async () => {
    vi.mocked(forgeListIssues).mockRejectedValue(
      backendError({
        code: "configuration_invalid",
        message: "the account for this repository's host is not usable",
        detail: "no stored token for account acc-1",
      })
    )
    mount()

    // `detail` wins over `message` — it is the specific half.
    expect(
      await screen.findByText("no stored token for account acc-1")
    ).toBeInTheDocument()
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument()
    // Not the actionable failure: no button to a flow that would not help.
    expect(
      screen.queryByRole("button", { name: "Add an account" })
    ).not.toBeInTheDocument()
  })

  it("localizes the no-account failure and offers the way out of it", async () => {
    const user = userEvent.setup()
    vi.mocked(forgeListIssues).mockRejectedValue(
      backendError({
        code: "configuration_missing",
        message: "no GitHub account for host github.com",
        i18n_key: "Forge.errors.noAccount",
        i18n_params: { host: "github.com", provider: "GitHub" },
      })
    )
    mount()

    // The i18n key wins over the English `message`, with both params filled in.
    expect(
      await screen.findByText(
        "No GitHub account is configured for github.com. Add one under Settings → Version Control to load this repository."
      )
    ).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Add an account" }))
    // The section slug must be one `resolve_settings_route` knows, or the
    // window silently lands on Appearance.
    expect(openSettingsWindow).toHaveBeenCalledWith("version-control")
  })

  /**
   * Issue #611: a self-hosted GitLab that codeg had classified as a GitHub
   * Enterprise. The backend recognises GitLab's "API V3 is no longer supported"
   * 410 and CORRECTS ITSELF before returning, so `wrongForge` describes
   * bookkeeping that is already fixed — putting it on screen would report our
   * own mistake as the user's problem. The panel asks again instead.
   *
   * The second `folderForgeRemote` answer is the point of re-deriving the
   * remote rather than just re-listing: `provider` is what the tab wording
   * reads, so the correction has to reach it too.
   */
  it("silently retries a wrong-forge failure instead of showing it", async () => {
    vi.mocked(folderForgeRemote)
      .mockResolvedValueOnce(REMOTE)
      .mockResolvedValue({
        ...REMOTE,
        server_host: "git.corp.com",
        provider: "gitlab",
      })
    vi.mocked(forgeListIssues)
      .mockRejectedValueOnce(
        backendError({
          code: "network_error",
          message:
            "git.corp.com is a GitLab, not the forge it was addressed as",
          i18n_key: "Forge.errors.wrongForge",
          i18n_params: { host: "git.corp.com", provider: "GitLab" },
        })
      )
      .mockResolvedValue(listOf([issue(42, "Login times out")]))
    mount()

    // The retry's rows, not the failure.
    expect(await screen.findByText("Login times out")).toBeInTheDocument()
    expect(
      screen.queryByText(/not the forge codeg had it classified as/)
    ).not.toBeInTheDocument()
    // Re-derived, so the panel now calls them merge requests. The accessible
    // name carries the count badge too, hence the regex.
    expect(vi.mocked(folderForgeRemote).mock.calls.length).toBeGreaterThan(1)
    expect(
      await screen.findByRole("tab", { name: /Merge requests/ })
    ).toBeInTheDocument()
  })

  /**
   * One retry, not a loop. The backend caches the detection before it reports
   * `wrongForge`, so a SECOND one means something else is wrong — and a panel
   * that kept retrying would spin instead of saying so.
   */
  it("shows a wrong-forge failure that survives the retry", async () => {
    vi.mocked(forgeListIssues).mockRejectedValue(
      backendError({
        code: "network_error",
        message: "git.corp.com is a GitLab, not the forge it was addressed as",
        i18n_key: "Forge.errors.wrongForge",
        i18n_params: { host: "git.corp.com", provider: "GitLab" },
      })
    )
    mount()

    expect(
      await screen.findByText(
        "git.corp.com is a GitLab, not the forge codeg had it classified as. The detection has been corrected — reload to retry."
      )
    ).toBeInTheDocument()
  })

  it("recovers: a later successful fetch clears the failure", async () => {
    const user = userEvent.setup()
    vi.mocked(forgeListIssues)
      .mockRejectedValueOnce(
        backendError({
          code: "network_error",
          message: "forge API request failed",
          detail: "forge network error: connection refused",
        })
      )
      .mockResolvedValue(listOf([issue(42, "Login times out")]))
    mount()

    await screen.findByText("forge network error: connection refused")
    await user.click(screen.getByRole("button", { name: "Refresh" }))

    expect(await screen.findByText("Login times out")).toBeInTheDocument()
    await waitFor(() =>
      expect(
        screen.queryByText("forge network error: connection refused")
      ).not.toBeInTheDocument()
    )
  })
})

/**
 * The sort control is offered only where the forge can honour it.
 *
 * Gitea cannot: its issues endpoint hard-codes newest-first and takes no sort
 * parameter at all, so a select there would change the URL, change nothing on
 * the server, and leave a list that says it is sorted one way while being
 * sorted another. Hiding it is the honest version of that, and it costs
 * nothing — the state stays at `newest`, which is exactly what Gitea serves.
 */
describe("ForgePage sort control", () => {
  const GITEA: ForgeRemote = {
    server_host: "git.corp.example",
    owner_repo: "acme/app",
    remote_url: "https://git.corp.example/acme/app.git",
    provider: "gitea",
    supported: true,
  }

  it("is offered on a forge that can order its list", async () => {
    vi.mocked(folderForgeRemote).mockResolvedValue(REMOTE)
    mount()

    expect(
      await screen.findByRole("combobox", { name: "Sort" })
    ).toBeInTheDocument()
  })

  it("is absent on Gitea, which serves one order and takes no parameter", async () => {
    vi.mocked(folderForgeRemote).mockResolvedValue(GITEA)
    mount()

    // Waited for through something the page only renders once the remote has
    // resolved — otherwise this passes on the frame before the control would
    // have appeared, whichever provider it is.
    await waitFor(() => expect(forgeListIssues).toHaveBeenCalled())
    expect(
      screen.queryByRole("combobox", { name: "Sort" })
    ).not.toBeInTheDocument()
  })
})

/**
 * A repository codeg cannot read at all — Bitbucket, Gitee, an unrecognized
 * self-hosted instance.
 *
 * Its remote parses perfectly well and resolves to a provider, because the
 * backend's last resort for an unrecognized host is GitHub. What it does NOT
 * resolve to is an API that can answer, so the panel used to spend the request
 * anyway and report back whatever the wrong forge said — "no GitHub account for
 * gitee.com", or a raw API failure — neither of which names the real limit.
 */
describe("ForgePage on a host that is neither forge", () => {
  const UNSUPPORTED: ForgeRemote = {
    server_host: "gitee.com",
    owner_repo: "someone/thing",
    remote_url: "https://gitee.com/someone/thing.git",
    // What the backend guessed, and exactly why the flag has to be separate:
    // the provider alone cannot tell this apart from a self-hosted Enterprise.
    provider: "github",
    supported: false,
  }

  it("names the forges it does support, and asks nothing of either", async () => {
    vi.mocked(folderForgeRemote).mockResolvedValue(UNSUPPORTED)
    mount()

    expect(
      await screen.findByText(
        "The repository panel supports GitHub, GitLab and Gitea only, and gitee.com is not recognized as any of them. If it is a self-hosted GitHub Enterprise, GitLab, Gitea or Forgejo instance, add an account for it under Settings → Version Control."
      )
    ).toBeInTheDocument()
    // No request is worth spending on a host no credential of ours fits — not
    // the list, not the hidden tab's badge, not the label vocabulary.
    expect(forgeListIssues).not.toHaveBeenCalled()
    expect(forgeTabCount).not.toHaveBeenCalled()
    expect(forgeListLabels).not.toHaveBeenCalled()
  })

  it("offers no write it could not carry out, and still names the repository", async () => {
    const user = userEvent.setup()
    vi.mocked(folderForgeRemote).mockResolvedValue(UNSUPPORTED)
    mount()
    await screen.findByRole("button", { name: "Add an account" })

    // The bar still says which repository this is — the folder is real, and
    // being unreadable is not a reason to stop naming it.
    expect(
      screen.getByRole("button", { name: /someone\/thing/ })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "New issue" })
    ).not.toBeInTheDocument()

    // The account button stays, because declaring an account for the host is
    // also how a self-hosted instance under an unrelated name gets in.
    await user.click(screen.getByRole("button", { name: "Add an account" }))
    expect(openSettingsWindow).toHaveBeenCalledWith("version-control")
  })
})

describe("repoWebUrl", () => {
  const at = (overrides: Partial<ForgeRemote>): ForgeRemote => ({
    ...REMOTE,
    ...overrides,
  })

  it("uses an https remote as-is, minus the .git", () => {
    expect(repoWebUrl(at({ remote_url: "https://github.com/o/r.git" }))).toBe(
      "https://github.com/o/r"
    )
    // A self-hosted instance's scheme, port and mount path all survive —
    // rebuilding from the host alone would drop every one of them.
    expect(
      repoWebUrl(
        at({ remote_url: "http://git.corp.com:8443/gitlab/team/app.git" })
      )
    ).toBe("http://git.corp.com:8443/gitlab/team/app")
  })

  it("falls back to the canonical page for an unopenable remote", () => {
    // A browser cannot open either of these; the coordinates are all there is.
    for (const url of ["git@github.com:o/r.git", "ssh://git@github.com/o/r"]) {
      expect(
        repoWebUrl(at({ remote_url: url, owner_repo: "xintaofei/codeg" }))
      ).toBe("https://github.com/xintaofei/codeg")
    }
  })
})

describe("ForgePage pagination", () => {
  /** The page number every call so far asked for. */
  function askedPages(): number[] {
    return sentQueries().map((query) => query.page ?? 1)
  }

  it("asks the backend for the page that was clicked", async () => {
    const user = userEvent.setup()
    // 57 matches at 20 per page → 3 pages.
    vi.mocked(forgeListIssues).mockImplementation(async (_folderId, req) =>
      listOf([issue(req.page ?? 1, `row on page ${req.page}`)], {
        page: req.page ?? 1,
        total_count: 57,
        has_next: (req.page ?? 1) < 3,
      })
    )
    mount()
    expect(await screen.findByText("row on page 1")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Go to page 3" }))
    expect(await screen.findByText("row on page 3")).toBeInTheDocument()
    expect(askedPages()).toEqual([1, 3])

    // Previous walks back one; Next is dead on the last page.
    await user.click(screen.getByRole("button", { name: "Previous page" }))
    await waitFor(() => expect(askedPages()).toEqual([1, 3, 2]))
  })

  /** GitLab withholds its totals past 10k rows, and its locally-filtered
   *  closed-MR query withholds them always. Page numbers invented from a
   *  count nobody sent would lead to pages that do not exist. */
  it("degrades to previous/next when the forge sent no total", async () => {
    vi.mocked(forgeListIssues).mockResolvedValue(
      listOf([issue(1, "only row")], { total_count: null, has_next: true })
    )
    mount()
    await screen.findByText("only row")

    expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled()
    expect(screen.queryByRole("button", { name: /Go to page/ })).toBeNull()
  })

  it("says so when the search came back partial", async () => {
    vi.mocked(forgeListIssues).mockResolvedValue(
      listOf([issue(1, "a row")], { incomplete: true })
    )
    mount()
    expect(
      await screen.findByText(
        "The search timed out, so this page may be missing matches."
      )
    ).toBeInTheDocument()
  })

  it("remembers the page size and returns to page 1 when it changes", async () => {
    const user = userEvent.setup()
    vi.mocked(forgeListIssues).mockImplementation(async (_folderId, req) =>
      listOf([issue(1, "a row")], {
        page: req.page ?? 1,
        per_page: req.perPage ?? 20,
        total_count: 500,
        has_next: true,
      })
    )
    mount()
    await screen.findByText("a row")
    await user.click(screen.getByRole("button", { name: "Go to page 2" }))
    await waitFor(() => expect(askedPages()).toEqual([1, 2]))

    await user.click(screen.getByRole("combobox", { name: "Per page" }))
    await user.click(await screen.findByRole("option", { name: "50" }))

    await waitFor(() => {
      // Page 2 of 20-row pages is not page 2 of 50-row pages; staying there
      // would silently show a different slice than the one being left.
      expect(lastQuery()).toMatchObject({ page: 1, perPage: 50 })
    })
    expect(localStorage.getItem("workspace:forge-page-size")).toBe("50")

    // A fresh mount reads the remembered size back.
    cleanup()
    vi.mocked(forgeListIssues).mockClear()
    mount()
    await waitFor(() => expect(sentQueries()[0].perPage).toBe(50))
  })

  /**
   * The switcher position is remembered for the same reason the page SIZE is
   * and the page NUMBER is not: it says which list you work in, not where you
   * happened to be in one. Someone who lives in pull requests should not have
   * to click past Issues every time the panel opens.
   */
  it("remembers which tab was last open, and opens there next time", async () => {
    const user = userEvent.setup()
    vi.mocked(forgeListIssues).mockResolvedValue(listOf([issue(1, "a row")]))
    mount()
    await screen.findByText("a row")
    // Loose match: the tab carries its count badge in its accessible name.
    await user.click(screen.getByRole("tab", { name: /Pull requests/ }))
    await waitFor(() => expect(lastQuery()).toMatchObject({ tab: "prs" }))
    expect(localStorage.getItem("workspace:forge-tab")).toBe("prs")

    // A fresh mount opens on it — first request and all, so the remembered
    // tab costs no round trip on the one it is not.
    cleanup()
    vi.mocked(forgeListIssues).mockClear()
    mount()
    await waitFor(() => expect(sentQueries()[0].tab).toBe("prs"))
  })

  it("opens on Issues when nothing was remembered, or the entry is junk", async () => {
    vi.mocked(forgeListIssues).mockResolvedValue(listOf([issue(1, "a row")]))
    mount()
    await waitFor(() => expect(sentQueries()[0].tab).toBe("issues"))

    // A hand-edited entry names a tab the switcher cannot show and no list can
    // be fetched for, so it reads back as the default rather than as itself.
    cleanup()
    vi.mocked(forgeListIssues).mockClear()
    localStorage.setItem("workspace:forge-tab", "merge-requests")
    mount()
    await waitFor(() => expect(sentQueries()[0].tab).toBe("issues"))
  })

  /** Narrowing the result set redefines what "page 4" means; the old number
   *  would land past the end of the new list and read as empty. */
  it("returns to page 1 when a filter changes", async () => {
    const user = userEvent.setup()
    vi.mocked(forgeListIssues).mockImplementation(async (_folderId, req) =>
      listOf([issue(1, "a row")], {
        page: req.page ?? 1,
        total_count: 500,
        has_next: true,
      })
    )
    mount()
    await screen.findByText("a row")
    // From page 1 of 25 the strip offers 1, 2, …, 25 — walk out to page 3 so
    // the reset below has somewhere to come back from.
    await user.click(screen.getByRole("button", { name: "Go to page 2" }))
    await waitFor(() => expect(askedPages()).toEqual([1, 2]))
    await user.click(screen.getByRole("button", { name: "Go to page 3" }))
    await waitFor(() => expect(askedPages()).toEqual([1, 2, 3]))

    // Loose match: the switcher carries a count badge, so the tab's
    // accessible name is "Pull requests" plus however many there are.
    await user.click(screen.getByRole("tab", { name: /Pull requests/ }))
    await waitFor(() =>
      expect(lastQuery()).toMatchObject({ page: 1, tab: "prs" })
    )
  })
})

/**
 * Reloading is the one control that acts on the WHOLE list rather than
 * narrowing it, so it lives in the window chrome beside the settings gear.
 * That puts the button and the fetch it triggers in different branches of the
 * tree, with a store as the only thing between them — which is exactly why it
 * needs its own tests: a handler left behind, or one never published, both
 * leave a button that looks alive and does nothing.
 */
describe("ForgePage reload button", () => {
  function reloadButton() {
    return screen.getByRole("button", { name: "Refresh" })
  }

  it("stays dead while no page has offered anything to reload", () => {
    render(<Shell page={false} />)
    // Clicking would be a no-op the button gave no sign of.
    expect(reloadButton()).toBeDisabled()
  })

  it("refetches the mounted page, and lets go of it again on unmount", async () => {
    const user = userEvent.setup()
    vi.mocked(forgeListIssues).mockResolvedValue(listOf([issue(1, "a row")]))
    const { rerender } = render(<Shell />)
    await screen.findByText("a row")
    await waitFor(() => expect(reloadButton()).toBeEnabled())

    await user.click(reloadButton())
    await waitFor(() => expect(sentQueries()).toHaveLength(2))
    // The hidden tab's count comes with it. Reloading only the rows would
    // leave a stale number on the switcher, above a list just refreshed
    // underneath it — and the VISIBLE tab's number rides in on the list.
    await waitFor(() => expect(forgeTabCount).toHaveBeenCalledTimes(2))

    // The page goes; the chrome stays. A handler left behind would point at a
    // fetch belonging to a page that no longer exists.
    rerender(<Shell page={false} />)
    await waitFor(() => expect(reloadButton()).toBeDisabled())
  })

  it("spins while the fetch runs, and refuses to stack another on top", async () => {
    let release: (list: ForgeIssueList) => void = () => {}
    vi.mocked(forgeListIssues).mockImplementation(
      () =>
        new Promise<ForgeIssueList>((resolve) => {
          release = resolve
        })
    )
    mount()

    await waitFor(() =>
      expect(reloadButton().querySelector(".animate-spin")).not.toBeNull()
    )
    expect(reloadButton()).toBeDisabled()

    release(listOf([issue(1, "a row")]))
    await screen.findByText("a row")
    await waitFor(() => expect(reloadButton()).toBeEnabled())
    expect(reloadButton().querySelector(".animate-spin")).toBeNull()
  })
})

/**
 * The gear beside reload. Sender and receiver are in two different branches of
 * the tree — the button is drawn in the window chrome, the dialog belongs to
 * the page — so the only thing worth asserting is that the event actually
 * crosses between them.
 */
describe("ForgePage settings button", () => {
  function settingsButton() {
    return screen.getByRole("button", { name: "Panel settings" })
  }

  it("opens the panel's preferences from the window chrome", async () => {
    const user = userEvent.setup()
    vi.mocked(forgeListIssues).mockResolvedValue(listOf([issue(1, "a row")]))
    mount()
    await screen.findByText("a row")

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    await user.click(settingsButton())
    // Opened on the folder whose list is on screen, not on the global row —
    // that is the scope the gear beside THIS list is about.
    expect(
      await screen.findByText("How issues and changes in codeg are handled.")
    ).toBeInTheDocument()
  })

  it("stays live over a folder with no repository at all", async () => {
    // Unlike reload: the preferences exist whatever the folder resolves to, so
    // there is something to change even when the list has nothing to show.
    vi.mocked(folderForgeRemote).mockResolvedValue(null)
    mount()
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled()
    )
    expect(settingsButton()).toBeEnabled()
  })
})

/**
 * The header's own four features. Each of them narrows or reorders the SERVER's
 * result set — filtering the one page already on screen would contradict both
 * the total and the page numbers sitting right underneath it.
 */
describe("ForgePage header", () => {
  function askedPage(): number {
    return lastQuery().page ?? 1
  }

  function listing(overrides: Partial<ForgeIssueList> = {}) {
    vi.mocked(forgeListIssues).mockImplementation(async (_folderId, req) =>
      listOf([issue(1, "a row")], {
        page: req.page ?? 1,
        total_count: 57,
        has_next: true,
        ...overrides,
      })
    )
  }

  /** The app's own overlay scrollbar (OverlayScrollbars, as the sidebar's
   *  conversation list uses), not the platform's. Besides matching, it
   *  OVERLAYS: a native scrollbar takes a column of the viewport, which pulled
   *  every row's trailing action a scrollbar's width left of the filters
   *  sitting directly above them. */
  it("scrolls the list with the app's own scrollbar", async () => {
    listing()
    const { container } = mount()
    const row = await screen.findByText("a row")

    const viewport = container.querySelector(
      "[data-overlayscrollbars-initialize]"
    )
    expect(viewport).not.toBeNull()
    expect(viewport).toContainElement(row)
    expect(container.querySelector(".overflow-y-auto")).toBeNull()
  })

  it("names the repository without the host, and links to it", async () => {
    listing()
    mount()
    // The host is the same for every row on the page; it only ever pushed the
    // part that identifies the project out of view. It survives in the tooltip.
    const repo = await screen.findByRole("button", { name: /xintaofei\/codeg/ })
    expect(repo).toHaveAccessibleName("xintaofei/codeg")
    expect(repo).toHaveAttribute(
      "title",
      "Open the repository · github.com/xintaofei/codeg"
    )
    expect(screen.queryByText("github.com/xintaofei/codeg")).toBeNull()
  })

  /** WHERE the list comes from is one fact read in two halves — you pick the
   *  folder, the repository follows from it — so they sit in one group rather
   *  than as a control up here and a caption somewhere else. */
  it("keeps the folder picker and the repository in one group", async () => {
    listing()
    mount()
    const repo = await screen.findByRole("button", {
      name: /xintaofei\/codeg/,
    })
    const folder = screen.getByRole("button", {
      name: /codeg/,
      expanded: false,
    })
    expect(folder).not.toBe(repo)
    expect(repo.parentElement).toBe(folder.parentElement)
  })

  /** A folder with no forge remote still has to be swappable — losing the
   *  repository must not take the picker down with it. */
  it("keeps the picker when the folder has no remote", async () => {
    vi.mocked(folderForgeRemote).mockResolvedValue(null)
    mount()
    expect(
      await screen.findByRole("button", { name: /codeg/, expanded: false })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /xintaofei\/codeg/ })
    ).toBeNull()
  })

  /** The heading and the caption under it are gone: the switcher already
   *  names what you are looking at, in a control you can act on, and the
   *  route's own name sits in the chrome strip above it. */
  it("names the list on the switcher, not in a heading above it", async () => {
    listing()
    mount()
    await screen.findByText("a row")
    expect(screen.queryByRole("heading")).toBeNull()
    expect(screen.getByRole("tab", { name: /Issues/ })).toHaveAttribute(
      "data-state",
      "active"
    )
  })

  /** Both counts, not just the tab you are on: the number that earns its place
   *  is the one for the tab you are NOT on. Filtered by the state/label/text
   *  filters in force, because it replaces a caption that was, and because it
   *  has to agree with the page numbers at the bottom of the same screen. */
  it("badges both tabs with their counts under the current filters", async () => {
    listing()
    mount()

    const issues = await screen.findByRole("tab", { name: /Issues/ })
    const prs = screen.getByRole("tab", { name: /Pull requests/ })
    // Found BY the title: a bare number beside a word says nothing on its own,
    // and "57 open" is the half that names which fifty-seven.
    await waitFor(() =>
      expect(within(issues).getByTitle("57 open")).toHaveTextContent("57")
    )
    expect(within(prs).getByTitle("3 open")).toHaveTextContent("3")
  })

  /** A count nobody sent must not be invented — GitLab withholds it past 10k
   *  rows and for its locally-filtered closed-MR query. A zero there would be
   *  a claim, and the whole point is that nobody made one. */
  it("shows no badge for a tab the forge would not count", async () => {
    listing()
    vi.mocked(forgeTabCount).mockResolvedValue(null)
    mount()
    await screen.findByText("a row")
    const issues = screen.getByRole("tab", { name: /Issues/ })
    await waitFor(() =>
      expect(within(issues).getByTitle("57 open")).toBeTruthy()
    )
    const prs = screen.getByRole("tab", { name: /Pull requests/ })
    expect(within(prs).queryByTitle(/open$/)).toBeNull()
    expect(prs).toHaveTextContent(/^Pull requests$/)
  })

  /** Open and closed together are not everything — a merged pull request is in
   *  neither on GitLab, and neither of them is a history. Both forges already
   *  express "no state qualifier at all" (`state=all` at GitLab, nothing at all
   *  in GitHub's `q`), so this is a filter value, not a third code path. */
  it("offers a third state that drops the qualifier entirely", async () => {
    const user = userEvent.setup()
    listing()
    mount()
    await screen.findByText("a row")
    // Open by default: a triage list opens on the work that is still work.
    expect(sentQueries()[0].state).toBe("open")

    await user.click(screen.getByRole("button", { name: "Go to page 2" }))
    await waitFor(() => expect(askedPage()).toBe(2))
    await user.click(screen.getByRole("combobox", { name: "State" }))
    await user.click(await screen.findByRole("option", { name: "All" }))

    await waitFor(() =>
      expect(lastQuery()).toMatchObject({ state: "all", page: 1 })
    )
    // …and the badge stops claiming the number is a number of OPEN ones.
    const issues = screen.getByRole("tab", { name: /Issues/ })
    await waitFor(() =>
      expect(within(issues).getByTitle("57 in total")).toBeTruthy()
    )
  })

  /** Row one is WHERE the list comes from and WHICH kind of thing is in it;
   *  everything that merely narrows it — the search box included — is a row
   *  down. Document order is the assertable half of that. */
  it("puts the search box below the switcher, at the head of the filters", async () => {
    listing()
    mount()
    await screen.findByText("a row")
    const tabs = screen.getByRole("tablist")
    const box = screen.getByRole("textbox", {
      name: "Search title and description…",
    })
    const filterRow = box.closest("div.flex.flex-wrap")
    // Its own row, not the switcher's…
    expect(filterRow).not.toContainElement(tabs)
    // …and the head of it: nothing between it and the row above.
    expect(filterRow?.firstElementChild).toContainElement(box)
  })

  /** The counts do not depend on the page or the order, so neither may spend a
   *  request on them; and the tab on screen must not spend one either, because
   *  its number already came back inside its own list response. GitHub's search
   *  endpoint allows thirty calls a MINUTE — a probe per page turn, or a second
   *  probe for a number already in hand, would have been most of that. */
  it("re-counts when the filters change, never when the view does", async () => {
    const user = userEvent.setup()
    listing()
    mount()
    await screen.findByText("a row")
    // ONE probe, and for the tab that is NOT showing.
    await waitFor(() => expect(forgeTabCount).toHaveBeenCalledTimes(1))
    expect(vi.mocked(forgeTabCount).mock.calls[0][1]).toBe("prs")

    // Switching tabs trades which number is free for which is probed — and
    // both are already filed under these filters, so it costs nothing.
    await user.click(screen.getByRole("tab", { name: /Pull requests/ }))
    await user.click(
      await screen.findByRole("button", { name: "Go to page 2" })
    )
    await user.click(screen.getByRole("combobox", { name: "Sort" }))
    await user.click(await screen.findByRole("option", { name: "Oldest" }))
    await waitFor(() => expect(lastQuery()).toMatchObject({ sort: "oldest" }))
    expect(forgeTabCount).toHaveBeenCalledTimes(1)

    // The state filter DOES redefine both numbers — one probe, for the tab
    // that is hidden NOW (Issues, since the user switched).
    await user.click(screen.getByRole("combobox", { name: "State" }))
    await user.click(await screen.findByRole("option", { name: "Closed" }))
    await waitFor(() => expect(forgeTabCount).toHaveBeenCalledTimes(2))
    expect(vi.mocked(forgeTabCount).mock.calls[1][1]).toBe("issues")
    expect(vi.mocked(forgeTabCount).mock.calls[1][2]).toMatchObject({
      state: "closed",
    })
  })

  /** A search GitHub admits was cut short counted FEWER items than match. The
   *  footer has room to say so; a bare digit on a tab does not, so it goes. */
  it("withholds the visible tab's badge when the search was incomplete", async () => {
    listing({ incomplete: true })
    mount()
    await screen.findByText("a row")

    const issues = screen.getByRole("tab", { name: /Issues/ })
    await waitFor(() =>
      expect(screen.getByText(/search timed out/i)).toBeTruthy()
    )
    expect(within(issues).queryByTitle(/open$/)).toBeNull()
    // The other tab's probe is unaffected — it answered completely.
    const prs = screen.getByRole("tab", { name: /Pull requests/ })
    expect(within(prs).getByTitle("3 open")).toHaveTextContent("3")
  })

  /** GitHub search MATCHES without limit but PAGES only the first thousand,
   *  answering 422 past them. Page numbers therefore come from what is
   *  reachable, or the strip would offer page 1 200 as a button into an
   *  error — and the gap between the two numbers is said in words, because a
   *  strip that just stops reads as a bug rather than as the forge's ceiling. */
  it("stops the page strip where the forge stops paging", async () => {
    listing({ total_count: 24_000, reachable_count: 1000, per_page: 20 })
    mount()
    await screen.findByText("a row")

    // 1000 reachable at 20 a page = 50, not 24 000 / 20 = 1200.
    expect(screen.getByRole("button", { name: "Go to page 50" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Go to page 1200" })).toBeNull()
    // Split in two so the grouping separator is not what the test rests on.
    const notice = screen.getByText(/can be paged through/i)
    expect(notice.textContent).toMatch(/1,?000/)
  })

  it("waits for typing to stop, then searches server-side from page 1", async () => {
    const user = userEvent.setup()
    listing()
    mount()
    await screen.findByText("a row")
    await user.click(screen.getByRole("button", { name: "Go to page 2" }))
    await waitFor(() => expect(askedPage()).toBe(2))

    const box = screen.getByRole("textbox", {
      name: "Search title and description…",
    })
    await user.type(box, "login")

    await waitFor(() =>
      // One request for the settled text, not one per keystroke: GitHub's
      // search endpoint allows thirty calls a MINUTE.
      expect(lastQuery()).toMatchObject({ search: "login", page: 1 })
    )
    expect(sentQueries().filter((q) => q.search === "logi")).toHaveLength(0)

    // Escape empties the box, which is itself a filter change.
    await user.type(box, "{Escape}")
    await waitFor(() => expect(lastQuery().search).toBe(""))
  })

  it("sends the labels that were ticked, and clears them again", async () => {
    const user = userEvent.setup()
    listing()
    mount()
    await screen.findByText("a row")
    // Off page 1 first, so the reset below is load-bearing: two labels narrow
    // the list, and page 2 of the narrower one is a different slice.
    await user.click(screen.getByRole("button", { name: "Go to page 2" }))
    await waitFor(() => expect(askedPage()).toBe(2))

    await user.click(screen.getByRole("button", { name: /Labels/ }))
    await user.click(await screen.findByRole("option", { name: "bug" }))
    // The popover stays open — picking two labels must not be two trips.
    await user.click(screen.getByRole("option", { name: "help wanted" }))
    await waitFor(() =>
      expect(lastQuery()).toMatchObject({
        labels: ["bug", "help wanted"],
        page: 1,
      })
    )

    await user.click(screen.getByRole("option", { name: "Clear labels" }))
    await waitFor(() => expect(lastQuery().labels).toEqual([]))
  })

  /** The filter's rows carry the project's colours too, as dots rather than
   *  full chips: this list is scanned for a NAME, and a stack of coloured
   *  pills would fight the row's own selected state. A label the forge gave no
   *  usable colour keeps a hollow ring, so the column stays a column. */
  it("marks each label in the filter with its own colour", async () => {
    const user = userEvent.setup()
    listing()
    mount()
    await screen.findByText("a row")

    await user.click(screen.getByRole("button", { name: /Labels/ }))
    const coloured = await screen.findByRole("option", { name: "bug" })
    const dot = coloured.querySelector<HTMLElement>("span")
    expect(dot?.style.backgroundColor).toBe("rgb(215, 58, 74)")

    const plain = screen.getByRole("option", { name: "help wanted" })
    expect(
      plain.querySelector<HTMLElement>("span")?.style.backgroundColor
    ).toBe("")
  })

  it("reorders server-side and returns to page 1", async () => {
    const user = userEvent.setup()
    listing()
    mount()
    await screen.findByText("a row")
    // The default is what github.com's own issue list opens on.
    expect(sentQueries()[0].sort).toBe("newest")

    await user.click(screen.getByRole("button", { name: "Go to page 2" }))
    await waitFor(() => expect(askedPage()).toBe(2))

    await user.click(screen.getByRole("combobox", { name: "Sort" }))
    await user.click(await screen.findByRole("option", { name: "Oldest" }))
    await waitFor(() =>
      expect(lastQuery()).toMatchObject({ sort: "oldest", page: 1 })
    )
  })

  /** A repository whose labels cannot be read still lists perfectly well — it
   *  just offers no label filter. */
  it("hides the label filter when there are no labels to offer", async () => {
    listing()
    vi.mocked(forgeListLabels).mockRejectedValue(new Error("403"))
    mount()
    await screen.findByText("a row")
    expect(screen.queryByRole("button", { name: /Labels/ })).toBeNull()
  })
})

/**
 * What the page does BETWEEN a click and the answer to it.
 *
 * A control has to respond to a click instantly — it is a control. Everything
 * else on screen can only answer a round trip later, and letting each of those
 * arrive on its own schedule is what made a slow forge look broken rather than
 * slow: the switcher said "Pull requests", the count said 57, and twenty issue
 * rows sat underneath both looking perfectly current.
 *
 * So: one flag, and three rules. What is still true stays and is marked stale.
 * What has stopped being true at all goes. Nothing moves.
 */
describe("ForgePage loading coordination", () => {
  /** A `forgeListIssues` whose answers are handed over one at a time. */
  function deferredListing() {
    const waiting: Array<(list: ForgeIssueList) => void> = []
    vi.mocked(forgeListIssues).mockImplementation(
      () =>
        new Promise<ForgeIssueList>((resolve) => {
          waiting.push(resolve)
        })
    )
    return async function settle(list: ForgeIssueList) {
      await waitFor(() => expect(waiting.length).toBeGreaterThan(0))
      // Inside `act`: handing over the answer is what drives the state update,
      // and React has no other way to know the render it causes was expected.
      await act(async () => {
        waiting.shift()?.(list)
      })
    }
  }

  /** A `forgeTabCount` whose answers are handed over one at a time, per tab —
   *  so a test can decide the hidden tab's badge lands BEFORE or AFTER the
   *  list that fills the visible one. */
  function deferredCounts() {
    const waiting: Array<{
      tab: ForgeTab
      resolve: (n: number | null) => void
    }> = []
    vi.mocked(forgeTabCount).mockImplementation(
      (_folderId, tab) =>
        new Promise<number | null>((resolve) => {
          waiting.push({ tab, resolve })
        })
    )
    return async function settle(tab: ForgeTab, value: number | null) {
      await waitFor(() => expect(waiting.some((w) => w.tab === tab)).toBe(true))
      const index = waiting.findIndex((w) => w.tab === tab)
      const [pending] = waiting.splice(index, 1)
      await act(async () => {
        pending.resolve(value)
      })
    }
  }

  /** The rows container, which carries the staleness mark. */
  function listRegion(): HTMLElement {
    const region = screen.getByText("first page").closest("[aria-busy]")
    expect(region).not.toBeNull()
    return region as HTMLElement
  }

  it("keeps the page you were reading, marked stale, while the next one loads", async () => {
    const user = userEvent.setup()
    const settle = deferredListing()
    mount()
    await settle(listOf([issue(1, "first page")], { total_count: 57 }))
    await screen.findByText("first page")
    await waitFor(() =>
      expect(listRegion()).toHaveAttribute("aria-busy", "false")
    )

    await user.click(screen.getByRole("combobox", { name: "Sort" }))
    await user.click(await screen.findByRole("option", { name: "Oldest" }))

    // Still there. Swapping in a screen of skeletons would throw away the
    // thing you are looking at in order to say it is being replaced.
    expect(screen.getByText("first page")).toBeInTheDocument()
    expect(listRegion()).toHaveAttribute("aria-busy", "true")
    expect(listRegion()).toHaveClass("opacity-50")

    await settle(listOf([issue(2, "reordered")], { total_count: 57 }))
    expect(await screen.findByText("reordered")).toBeInTheDocument()
    await waitFor(() =>
      expect(
        screen.getByText("reordered").closest("[aria-busy]")
      ).toHaveAttribute("aria-busy", "false")
    )
  })

  /** The typed text is 350ms away from being a request, but the list stopped
   *  matching the box the moment the first key landed. Saying so beats a third
   *  of a second of pretending otherwise. */
  it("marks the list stale as soon as the search box disagrees with it", async () => {
    const user = userEvent.setup()
    const settle = deferredListing()
    mount()
    await settle(listOf([issue(1, "first page")]))
    await screen.findByText("first page")
    await waitFor(() =>
      expect(listRegion()).toHaveAttribute("aria-busy", "false")
    )

    await user.type(
      screen.getByRole("textbox", { name: "Search title and description…" }),
      "log"
    )
    // Load-bearing pair: if the debounce had already fired, this would fail —
    // and the assertion below would be passing for the wrong reason.
    expect(sentQueries().every((q) => (q.search ?? "") === "")).toBe(true)
    expect(listRegion()).toHaveAttribute("aria-busy", "true")
  })

  /** Issues under a tab that says "Pull requests" — and, since round six, under
   *  a badge that says how many pull requests there are — is not a stale view
   *  of this list. It is a page of a different one. */
  it("drops the previous tab's rows instead of showing them under the other tab", async () => {
    const user = userEvent.setup()
    const settle = deferredListing()
    mount()
    await settle(listOf([issue(1, "an issue")]))
    await screen.findByText("an issue")

    await user.click(screen.getByRole("tab", { name: /Pull requests/ }))
    expect(screen.queryByText("an issue")).toBeNull()
    expect(screen.getByTestId("forge-list-skeleton")).toBeInTheDocument()

    await settle(listOf([{ ...issue(2, "a pull request"), is_pr: true }]))
    expect(await screen.findByText("a pull request")).toBeInTheDocument()
  })

  /**
   * The badges are two numbers that arrive from two places at two times — the
   * visible tab's inside its list, the hidden tab's from a probe — and the
   * dangerous move is treating "we are showing a number" as "we have this
   * number". Then a leftover from the PREVIOUS filters suppresses the request
   * that would have replaced it, and it stays on the tab as though it were an
   * answer.
   */
  it("never lets a leftover count stand in for one it never asked for", async () => {
    const user = userEvent.setup()
    const settleList = deferredListing()
    const settleCount = deferredCounts()
    mount()
    // Open: 57 issues (from the list) and 3 pull requests (from the probe).
    await settleList(listOf([issue(1, "first page")], { total_count: 57 }))
    await settleCount("prs", 3)
    await screen.findByText("first page")

    // Now ask for Closed. The hidden tab's probe answers FIRST…
    await user.click(screen.getByRole("combobox", { name: "State" }))
    await user.click(await screen.findByRole("option", { name: "Closed" }))
    await settleCount("prs", 8)

    // …and before the Issues list can answer, the user switches away, which
    // abandons that request. Nothing has counted closed issues at any point.
    await user.click(screen.getByRole("tab", { name: /Pull requests/ }))
    // The abandoned request still has to be answered; its result is dropped by
    // the request guard, which is the whole scenario. The sentinel is a number
    // no assertion below expects, so a badge showing it would be a failure and
    // not a coincidence.
    await settleList(listOf([issue(3, "abandoned")], { total_count: 999 }))
    await settleList(
      listOf([{ ...issue(2, "a pull request"), is_pr: true }], {
        total_count: 8,
      })
    )
    await screen.findByText("a pull request")
    expect(screen.queryByText("abandoned")).toBeNull()

    // So it must be asked for — the open count of 57 is not an answer about
    // closed issues, however recently it was on screen.
    await waitFor(() =>
      expect(
        vi
          .mocked(forgeTabCount)
          .mock.calls.some(
            (call) => call[1] === "issues" && call[2]?.state === "closed"
          )
      ).toBe(true)
    )
    await settleCount("issues", 21)
    const issues = screen.getByRole("tab", { name: /Issues/ })
    await waitFor(() =>
      expect(within(issues).getByTitle("21 closed")).toHaveTextContent("21")
    )
    expect(within(issues).queryByTitle(/^57/)).toBeNull()
  })

  /** Each tab's probe is its own request with its own generation. Sharing one
   *  would make the second probe cancel the first, so toggling the switcher on
   *  a slow forge would discard each answer as the next began — and re-spend
   *  it on the way back, against a quota of thirty calls a MINUTE. */
  it("spends at most one count probe per tab, however much the switcher is toggled", async () => {
    const user = userEvent.setup()
    deferredListing()
    const settleCount = deferredCounts()
    mount()
    await waitFor(() => expect(forgeTabCount).toHaveBeenCalledTimes(1))

    // Nothing has answered yet — every toggle happens mid-load.
    for (let i = 0; i < 3; i += 1) {
      await user.click(screen.getByRole("tab", { name: /Pull requests/ }))
      await user.click(screen.getByRole("tab", { name: /Issues/ }))
    }

    // Two numbers exist to be learned, so two requests is the ceiling: the
    // second and later visits to a tab recognize their own probe in flight.
    expect(vi.mocked(forgeTabCount).mock.calls.length).toBeLessThanOrEqual(2)
    const asked = vi.mocked(forgeTabCount).mock.calls.map((call) => call[1])
    expect(new Set(asked).size).toBe(asked.length)

    // …and neither answer was thrown away on the way. A shared generation
    // would have let each probe invalidate the other, so whichever landed
    // second would be the only badge on the switcher.
    await settleCount("prs", 3)
    await settleCount("issues", 57)
    const issues = screen.getByRole("tab", { name: /Issues/ })
    const prs = screen.getByRole("tab", { name: /Pull requests/ })
    await waitFor(() =>
      expect(within(issues).getByTitle("57 open")).toHaveTextContent("57")
    )
    expect(within(prs).getByTitle("3 open")).toHaveTextContent("3")
  })

  /**
   * The two writers are not independent just because they are different code.
   *
   * A list is as authoritative about the tab it just listed as a probe is, so
   * a probe already in the air when that list lands is an OLDER answer to the
   * same question — not a second opinion. Letting it through overwrites a
   * correct count with a stale one AND leaves nothing in flight to put it
   * right, because the probe only ever runs for the tab you cannot see.
   */
  it("does not let a probe from before a list land on top of it", async () => {
    const user = userEvent.setup()
    const settleList = deferredListing()
    const settleCount = deferredCounts()
    mount()

    // Open/Issues answers; the pull-request probe is left in the air.
    await settleList(listOf([issue(1, "first page")], { total_count: 57 }))
    await screen.findByText("first page")

    await user.click(screen.getByRole("tab", { name: /Pull requests/ }))
    await settleList(
      listOf([{ ...issue(2, "open pr"), is_pr: true }], { total_count: 3 })
    )
    await screen.findByText("open pr")

    // Closed, while the pull-request tab is the visible one — so its count
    // comes from its own list, and no new pull-request probe is owed.
    await user.click(screen.getByRole("combobox", { name: "State" }))
    await user.click(await screen.findByRole("option", { name: "Closed" }))
    await settleList(
      listOf([{ ...issue(4, "closed pr"), is_pr: true }], { total_count: 8 })
    )
    await screen.findByText("closed pr")

    // NOW the original Open probe finally answers. It is about a result set
    // two filters ago, and about a tab whose count is already settled.
    await settleCount("prs", 3)
    // The Issues probe answers too, so nothing is pending and the badges have
    // to stand on their own rather than on "still loading".
    await settleCount("issues", 21)

    const prs = screen.getByRole("tab", { name: /Pull requests/ })
    await waitFor(() =>
      expect(within(prs).getByTitle("8 closed")).toHaveTextContent("8")
    )
    expect(within(prs).queryByTitle(/^3/)).toBeNull()
    const issues = screen.getByRole("tab", { name: /Issues/ })
    expect(within(issues).getByTitle("21 closed")).toHaveTextContent("21")
  })

  /** The same rule, but here it is a CORRECTNESS one rather than a cosmetic
   *  one: those rows are numbered and linked against a repository the page has
   *  stopped showing, and "Start" on one of them would mint a task for that
   *  number in the NEW repository — which the folder/remote gate would wave
   *  through, because the repository it checks is the new one. */
  it("drops the previous repository's rows when the folder changes", async () => {
    const user = userEvent.setup()
    useAppWorkspaceStore.setState({
      folders: [
        { id: 1, name: "codeg", parent_id: null, kind: "regular" },
        { id: 2, name: "other-project", parent_id: null, kind: "regular" },
      ] as never,
    })
    const settle = deferredListing()
    mount()
    await settle(listOf([issue(1, "row from codeg")]))
    await screen.findByText("row from codeg")

    await user.click(
      screen.getByRole("button", { name: /codeg/, expanded: false })
    )
    await user.click(
      await screen.findByRole("option", { name: /other-project/ })
    )

    expect(screen.queryByText("row from codeg")).toBeNull()
    expect(screen.getByTestId("forge-list-skeleton")).toBeInTheDocument()
  })

  /** Letting the footer appear WITH the data lifts the whole list by the bar's
   *  own height at the exact moment the first row lands under the reader's
   *  eye. It holds its place from the start instead. */
  it("holds the footer's bar while the first page is still on its way", async () => {
    const settle = deferredListing()
    mount()
    expect(await screen.findByTestId("forge-footer")).toBeInTheDocument()
    expect(screen.queryByRole("navigation", { name: "Pagination" })).toBeNull()

    await settle(
      listOf([issue(1, "a row")], { total_count: 57, has_next: true })
    )
    await screen.findByText("a row")
    expect(screen.getByTestId("forge-footer")).toBeInTheDocument()
    expect(
      screen.getByRole("navigation", { name: "Pagination" })
    ).toBeInTheDocument()
  })
})

/**
 * The row's title opens the detail panel on the right instead of navigating
 * out to the forge's web page. The body it shows already rides along with every
 * row, so the panel costs no request — which is what makes it worth having over
 * a browser tab that also loses the list, its filters and its scroll position.
 *
 * Everything here is about the WIRING between page and panel: which row it
 * opens on, whether it keeps up with the list underneath it, and whether it
 * goes when the rows it belongs to do.
 */
describe("ForgePage detail panel", () => {
  function withBody(number: number, title: string, body: string | null) {
    return { ...issue(number, title), body }
  }

  async function openDetail(title: string) {
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: title }))
    return user
  }

  it("opens on the clicked row, with that item's body as Markdown", async () => {
    vi.mocked(forgeListIssues).mockResolvedValue(
      listOf([
        withBody(1, "first row", "## First"),
        withBody(2, "second row", "## Second"),
      ])
    )
    mount()
    await openDetail("second row")

    const panel = screen.getByRole("dialog")
    expect(within(panel).getByTestId("markdown")).toHaveTextContent("## Second")
    // The panel names the item it opened on, not the one above it.
    expect(within(panel).getByText("· #2")).toBeInTheDocument()
  })

  /** A row is a SNAPSHOT. Reload the list and the same item arrives again in a
   *  new object — the panel has to follow it, or it sits there showing what the
   *  list said when it opened while the row behind it says something else. */
  it("keeps up with the item's fresh copy when the list reloads under it", async () => {
    const user = userEvent.setup()
    vi.mocked(forgeListIssues).mockResolvedValue(
      listOf([withBody(1, "a row", "before")])
    )
    mount()
    await openDetail("a row")
    expect(screen.getByTestId("markdown")).toHaveTextContent("before")

    vi.mocked(forgeListIssues).mockResolvedValue(
      listOf([withBody(1, "a row", "after")])
    )
    await user.click(screen.getByRole("button", { name: "Refresh" }))
    await waitFor(() =>
      expect(screen.getByTestId("markdown")).toHaveTextContent("after")
    )
  })

  /** Same rule the rows themselves follow, and for the same reason: the panel
   *  carries its own copy of a row numbered against a repository the page has
   *  stopped showing, and its footer offers "Start" on it. */
  it("closes when the folder changes", async () => {
    useAppWorkspaceStore.setState({
      folders: [
        { id: 1, name: "codeg", parent_id: null, kind: "regular" },
        { id: 2, name: "other-project", parent_id: null, kind: "regular" },
      ] as never,
    })
    vi.mocked(forgeListIssues).mockResolvedValue(
      listOf([withBody(1, "row from codeg", "body")])
    )
    mount()
    await openDetail("row from codeg")
    expect(screen.getByRole("dialog")).toBeInTheDocument()

    // The folder changes out from under the page — the FALLBACK path the page
    // documents (the folder on screen leaves the workspace, so `effectiveFolderId`
    // drops to the first one left). Driven through the store rather than
    // through the picker because it is the same effect either way, and because
    // a press that lands in the same tick the drawer opened in gets swallowed
    // while the drawer is still settling its focus management — nothing a
    // person can hit, and not what this test is about.
    await act(async () => {
      useAppWorkspaceStore.setState({
        folders: [
          { id: 2, name: "other-project", parent_id: null, kind: "regular" },
        ] as never,
      })
    })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  /** The end of that same road: the LAST project folder goes, so there is no
   *  folder to fall back to. That path used to exit the resolution effect
   *  before any of the clean-up ran, leaving the panel mounted over a page that
   *  had gone back to "pick a folder" — with a "Start" whose dialog is gated on
   *  a folder, and so did nothing at all when pressed. */
  it("closes when the last folder leaves the workspace", async () => {
    vi.mocked(forgeListIssues).mockResolvedValue(
      listOf([withBody(1, "row from codeg", "body")])
    )
    mount()
    await openDetail("row from codeg")
    expect(screen.getByRole("dialog")).toBeInTheDocument()

    await act(async () => {
      useAppWorkspaceStore.setState({ folders: [] as never })
    })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    // The rows go with it, so nothing of the old repository is left on screen.
    expect(
      screen.queryByRole("button", { name: "row from codeg" })
    ).not.toBeInTheDocument()
  })

  /**
   * The panel outliving its row must not cost the item its TASK.
   *
   * The chip lookup asks about the rows on screen and replaces the whole map
   * with the answer, so an item the panel is still showing after a page turn
   * lost its entry — and the footer fell back from a live status chip to
   * "Start", offering to trigger work that was already running.
   */
  it("keeps the panel's task chip after its row leaves the page", async () => {
    const user = userEvent.setup()
    const keyOf = (number: number) =>
      buildForgeSourceKey({
        provider: "github",
        serverHost: REMOTE.server_host,
        ownerRepo: REMOTE.owner_repo,
        kind: "issue",
        number,
      })
    // Only #1 has ever been handled. Answering from the REQUESTED keys is the
    // whole point: a lookup that stopped asking about #1 gets nothing back.
    vi.mocked(workTaskLookupBySource).mockImplementation(async (keys) =>
      keys
        .filter((k) => k === keyOf(1))
        .map((source_key) => ({
          source_key,
          task_id: 3,
          status: "running" as const,
          verdict: null,
          updated_at: "2026-08-19T00:00:00Z",
        }))
    )
    vi.mocked(forgeListIssues).mockResolvedValue(
      listOf([withBody(1, "a row", "body")], { has_next: true })
    )
    mount()
    await openDetail("a row")
    const panel = screen.getByRole("dialog")
    expect(
      await within(panel).findByRole("button", { name: "Running" })
    ).toBeInTheDocument()

    // Page two: #1 is gone from the list, and the panel deliberately stays.
    vi.mocked(forgeListIssues).mockResolvedValue(
      listOf([withBody(2, "another row", "other body")], { page: 2 })
    )
    await user.click(screen.getByRole("button", { name: "Next page" }))
    await screen.findByText("another row")

    expect(within(panel).getByRole("button", { name: "Running" })).toBeVisible()
    expect(
      within(panel).queryByRole("button", { name: "Start" })
    ).not.toBeInTheDocument()
  })

  /**
   * A chip lookup that comes back LATE must not undo a newer one.
   *
   * Three things fire the lookup — the rows changing, a `work-task://changed`
   * event, and the trigger dialog — so two are routinely in flight at once,
   * and the answer replaces the whole map. Without a generation counter the
   * slower request wins whatever order they were SENT in, so an answer to a
   * question about last page's rows erases this page's links. The row then
   * reads a missing link as "never handled" and offers "Start" for work that
   * is already running, which is how a duplicate task gets created.
   */
  it("ignores a task-link answer a newer lookup already overtook", async () => {
    const user = userEvent.setup()
    const keyOf = (number: number) =>
      buildForgeSourceKey({
        provider: "github",
        serverHost: REMOTE.server_host,
        ownerRepo: REMOTE.owner_repo,
        kind: "issue",
        number,
      })
    const runningOn = (number: number, taskId: number): ForgeTaskLink => ({
      source_key: keyOf(number),
      task_id: taskId,
      status: "running",
      verdict: null,
      updated_at: "2026-08-19T00:00:00Z",
    })

    // Every lookup parks until the test releases it, so the order the answers
    // LAND in is the test's to choose rather than the scheduler's. Each is
    // still answered truthfully from the keys it actually asked about — the
    // stale response is a correct answer to an old question, which is exactly
    // the shape that made this go wrong.
    const parked: { keys: string[]; resolve: (v: ForgeTaskLink[]) => void }[] =
      []
    vi.mocked(workTaskLookupBySource).mockImplementation(
      (keys) =>
        new Promise<ForgeTaskLink[]>((resolve) => {
          parked.push({ keys, resolve })
        })
    )
    const answer = async (entry: (typeof parked)[number]) => {
      await act(async () => {
        entry.resolve(
          entry.keys
            .map((k) =>
              k === keyOf(1)
                ? runningOn(1, 3)
                : k === keyOf(2)
                  ? runningOn(2, 7)
                  : null
            )
            .filter((l): l is ForgeTaskLink => l != null)
        )
      })
    }

    vi.mocked(forgeListIssues).mockResolvedValue(
      listOf([issue(1, "a row")], { has_next: true })
    )
    mount()
    await screen.findByText("a row")
    // Everything asked about page one — held back, and answered last.
    const stale = parked.splice(0, parked.length)

    vi.mocked(forgeListIssues).mockResolvedValue(
      listOf([issue(2, "another row")], { page: 2 })
    )
    await user.click(screen.getByRole("button", { name: "Next page" }))
    await screen.findByText("another row")

    // Page two's lookup answers first, so #2 wears its chip.
    for (const entry of parked) await answer(entry)
    expect(
      await screen.findByRole("button", { name: "Running" })
    ).toBeInTheDocument()

    // Page one's finally comes back. It never asked about #2, so honoring it
    // would blank the chip that is on screen.
    for (const entry of stale) await answer(entry)
    expect(screen.getByRole("button", { name: "Running" })).toBeVisible()
    expect(
      screen.queryByRole("button", { name: "Start" })
    ).not.toBeInTheDocument()
  })

  /** "Start" inside the panel triggers the item the panel is open on, and
   *  leaves the panel standing: the dialog opens over it, and closing it comes
   *  back to a footer that now carries the new task's chip. */
  it("triggers the panel's own item from its footer", async () => {
    vi.mocked(forgeListIssues).mockResolvedValue(
      listOf([
        withBody(1, "first row", "one"),
        withBody(2, "second row", "two"),
      ])
    )
    mount()
    const user = await openDetail("second row")

    const panel = screen.getByRole("dialog")
    await user.click(within(panel).getByRole("button", { name: "Start" }))

    // The trigger dialog opens on #2 — the panel's item, not the first row,
    // and not whatever the list happens to start with. Its heading is
    // `#number · title`, so the number is what proves WHICH item was handed on.
    expect(
      await screen.findByRole("heading", { name: "#2 · second row" })
    ).toBeInTheDocument()
  })
})

/**
 * Filing a new issue, and adopting what the panel's writes answer with.
 *
 * The wiring the page owns: the button only exists once a repository is
 * resolved, the dialog files against THAT folder, and NO mutation is followed
 * by a list re-read. That last one is the load-bearing rule and it is not an
 * optimization — the list comes from GitHub's search index, which lags a write
 * by seconds to minutes, so a re-read lands a page that predates the write and
 * undoes it. Every write here is shown from the answer the forge gave it.
 */
describe("ForgePage writes", () => {
  it("offers no new-issue button until a repository is resolved", async () => {
    vi.mocked(folderForgeRemote).mockResolvedValue(null)
    vi.mocked(forgeListIssues).mockResolvedValue(listOf([]))
    mount()
    await screen.findByText(
      "This folder has no recognizable forge remote (origin)"
    )
    // Nowhere for the issue to go — the backend would refuse it, and a button
    // that can only fail is worse than no button.
    expect(
      screen.queryByRole("button", { name: "New issue" })
    ).not.toBeInTheDocument()
  })

  it("files against the folder on screen and opens the panel on what came back", async () => {
    const user = userEvent.setup()
    vi.mocked(forgeListIssues).mockResolvedValue(listOf([issue(1, "a row")]))
    vi.mocked(forgeCreateIssue).mockResolvedValue({
      ...issue(123, "Login times out"),
      body: "## Steps",
    })
    mount()
    await user.click(await screen.findByRole("button", { name: "New issue" }))

    await user.type(screen.getByLabelText("Title"), "Login times out")
    const before = vi.mocked(forgeListIssues).mock.calls.length
    await user.click(screen.getByRole("button", { name: "Create issue" }))

    await waitFor(() =>
      expect(forgeCreateIssue).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ title: "Login times out" })
      )
    )
    // Straight into the panel on what was just filed: the number and the link
    // the forge assigned are only visible there.
    const panel = await screen.findByRole("dialog")
    expect(within(panel).getByText("· #123")).toBeInTheDocument()
    // And into the list behind it, at the top, from the row the CREATE
    // answered with. This is the whole point: re-reading here would ask an
    // index that has not been told about the issue yet, get back the page
    // without it, and land that — which is what left a reader hitting the
    // refresh button to see what they had just filed.
    const rows = await screen.findAllByRole("button", { name: /Login times/ })
    expect(rows.length).toBeGreaterThan(0)
    expect(vi.mocked(forgeListIssues).mock.calls.length).toBe(before)
  })

  it("counts the issue it filed onto the tab badge", async () => {
    const user = userEvent.setup()
    vi.mocked(forgeListIssues).mockResolvedValue(
      listOf([issue(1, "a row")], { total_count: 57 })
    )
    vi.mocked(forgeCreateIssue).mockResolvedValue(issue(123, "Login times out"))
    mount()
    const tab = await screen.findByRole("tab", { name: /Issues/ })
    await waitFor(() => expect(within(tab).getByTitle("57 open")).toBeTruthy())

    await user.click(screen.getByRole("button", { name: "New issue" }))
    // Only has to be non-empty to enable the button — the title that matters is
    // the one the forge answers with, and it comes from the mock.
    await user.type(screen.getByLabelText("Title"), "x")
    await user.click(screen.getByRole("button", { name: "Create issue" }))

    // The badge counts MATCHES, and there is demonstrably one more of them.
    // Nothing re-reads to find that out, so the number has to be moved here or
    // it sits one short above a list that visibly gained a row.
    await waitFor(() =>
      expect(within(tab).getByTitle("58 open")).toHaveTextContent("58")
    )
  })

  it("leaves the pull-request list alone when an issue is filed from it", async () => {
    const user = userEvent.setup()
    vi.mocked(forgeListIssues).mockResolvedValue(listOf([issue(1, "a row")]))
    vi.mocked(forgeCreateIssue).mockResolvedValue(issue(123, "Login times out"))
    mount()
    await user.click(await screen.findByRole("tab", { name: /Pull requests/ }))
    await screen.findByRole("button", { name: "a row" })

    await user.click(screen.getByRole("button", { name: "New issue" }))
    // Only has to be non-empty to enable the button — the title that matters is
    // the one the forge answers with, and it comes from the mock.
    await user.type(screen.getByLabelText("Title"), "x")
    const before = vi.mocked(forgeListIssues).mock.calls.length
    await user.click(screen.getByRole("button", { name: "Create issue" }))

    // The panel opens on it — nothing filed ever goes unseen — so the list is
    // only readable again once that is out of the way (a modal takes the rest
    // of the tree out of the accessibility tree with it).
    const panel = await screen.findByRole("dialog")
    expect(within(panel).getByText("· #123")).toBeInTheDocument()
    await user.click(within(panel).getByRole("button", { name: "Close" }))

    // A new ISSUE is not a row of the pull-request list, and placing it there
    // would be showing it somewhere it will never be found again.
    expect(await screen.findByRole("button", { name: "a row" })).toBeTruthy()
    expect(
      screen.queryByRole("button", { name: /Login times/ })
    ).not.toBeInTheDocument()
    // And still no re-read: the index is no more current for this tab than the
    // other, so asking would only cost a request out of a 30-per-minute quota.
    expect(vi.mocked(forgeListIssues).mock.calls.length).toBe(before)
  })

  it("adopts the row a state change answered with, even after it leaves the list", async () => {
    const user = userEvent.setup()
    vi.mocked(forgeListIssues).mockResolvedValue(listOf([issue(1, "a row")]))
    vi.mocked(forgeSetItemState).mockResolvedValue({
      ...issue(1, "a row"),
      state: "closed",
    })
    mount()
    await user.click(await screen.findByRole("button", { name: "a row" }))

    await user.click(
      screen.getByRole("button", { name: "Close #1 on the forge" })
    )
    const listCalls = vi.mocked(forgeListIssues).mock.calls.length
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Close",
      })
    )

    // The panel reads its item out of the LOADED LIST whenever that still has
    // it, so adopting the answer into only `detailRow` would leave a
    // just-closed issue reading "Open" for as long as its stale row sat there.
    await waitFor(() => {
      const panel = screen.getByRole("dialog")
      expect(within(panel).getByText("Closed")).toBeInTheDocument()
    })
    // The row behind it says the same thing, from the same answer.
    expect(screen.getByRole("img", { name: "Closed" })).toBeInTheDocument()
    // And nothing was re-fetched. The list is served from GitHub's SEARCH
    // index, which lags a write by seconds — an immediate re-read would
    // routinely answer "open" and undo what the user watched succeed.
    expect(vi.mocked(forgeListIssues).mock.calls.length).toBe(listCalls)
  })
})

/**
 * A write on the forge makes any list request SENT BEFORE IT obsolete: that
 * answer was assembled from an index which had not seen the write. Both cases
 * below hold such a request open across the write and resolve it afterwards —
 * the ordering that used to put a just-closed issue back to "open" with
 * nothing left to correct it.
 */
describe("ForgePage write orderings", () => {
  /** A list refresh in flight when the close lands. Its answer is stale by
   *  construction — the index it was built from had not seen the write — and
   *  nothing re-fetches afterwards, so landing it raw would leave the wrong
   *  state on screen indefinitely. It lands, with the write written back. */
  it("writes the state change back over a list response that predates it", async () => {
    const user = userEvent.setup()
    let releaseList: (page: ForgeIssueList) => void = () => {}
    vi.mocked(forgeListIssues)
      .mockResolvedValueOnce(listOf([issue(1, "a row")]))
      .mockReturnValueOnce(
        new Promise<ForgeIssueList>((resolve) => {
          releaseList = resolve
        })
      )
    vi.mocked(forgeSetItemState).mockResolvedValue({
      ...issue(1, "a row"),
      state: "closed",
    })
    mount()
    await user.click(await screen.findByRole("button", { name: "a row" }))

    // A refresh goes out (the chrome button drives the page's own fetch) and
    // does not come back yet.
    await user.click(screen.getByRole("button", { name: "Refresh" }))
    await user.click(
      screen.getByRole("button", { name: "Close #1 on the forge" })
    )
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Close",
      })
    )
    await waitFor(() =>
      expect(
        within(screen.getByRole("dialog")).getByText("Closed")
      ).toBeInTheDocument()
    )

    // The stale answer arrives, still calling the issue open — and carrying a
    // SECOND row, so it is visibly not discarded.
    await act(async () => {
      releaseList(listOf([issue(1, "a row"), issue(2, "another row")]))
    })
    // Everything the response brought is on screen…
    expect(
      await screen.findByRole("button", { name: "another row" })
    ).toBeInTheDocument()

    // …except the one row the write knows better than it does.
    expect(
      within(screen.getByRole("dialog")).getByText("Closed")
    ).toBeInTheDocument()
    expect(screen.getByRole("img", { name: "Closed" })).toBeInTheDocument()
    // And the page is not left dimmed over a load nothing is loading: the
    // superseded response never reaches its own `finally`, so the busy flag
    // has to be cleared where the generation is claimed.
    expect(document.querySelector("[aria-busy='true']")).toBeNull()
  })

  /** A comment POST still in the air when a close resolves. The comment must
   *  add its one to the count and touch nothing else — a row captured when the
   *  post started would carry the pre-close state back over the newer one. */
  it("counts a comment that resolves after a close without undoing it", async () => {
    const user = userEvent.setup()
    vi.mocked(forgeListIssues).mockResolvedValue(
      listOf([{ ...issue(1, "a row"), comments: 4 }])
    )
    vi.mocked(forgeSetItemState).mockResolvedValue({
      ...issue(1, "a row"),
      state: "closed",
      comments: 4,
    })
    let releaseComment: (comment: ForgeComment) => void = () => {}
    vi.mocked(forgeCreateComment).mockReturnValue(
      new Promise<ForgeComment>((resolve) => {
        releaseComment = resolve
      })
    )
    vi.mocked(forgeListComments).mockResolvedValue({
      comments: [],
      page: 1,
      per_page: 20,
      has_next: false,
    })
    mount()
    await user.click(await screen.findByRole("button", { name: "a row" }))
    await screen.findByPlaceholderText("Leave a comment…")

    // Post, then close while the post is still out.
    await user.type(screen.getByPlaceholderText("Leave a comment…"), "hi")
    await user.click(screen.getByRole("button", { name: "Comment" }))
    await user.click(
      screen.getByRole("button", { name: "Close #1 on the forge" })
    )
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Close",
      })
    )
    await waitFor(() =>
      expect(
        within(screen.getByRole("dialog")).getByText("Closed")
      ).toBeInTheDocument()
    )

    await act(async () => {
      releaseComment({
        id: "9",
        author: "octocat",
        author_avatar: null,
        body: "hi",
        created_at: null,
        updated_at: null,
        html_url: null,
      })
    })

    const panel = screen.getByRole("dialog")
    // The close survives the late comment…
    expect(within(panel).getByText("Closed")).toBeInTheDocument()
    // …and the comment is still counted onto it.
    expect(within(panel).getByText("5 comments")).toBeInTheDocument()
  })
})

/**
 * The regression the first attempt at all this introduced: a write must not
 * be able to strand a view the user asked for while it was in flight.
 *
 * Discarding every in-flight list response on a write looked right when the
 * only request outstanding was a refresh of the SAME view. It was not: the
 * request a tab switch is waiting on is outstanding too, and throwing that
 * away left the new tab on skeletons with no dependency left to change and
 * re-fire the fetch.
 *
 * Driven through the COMMENT path deliberately. A state change is confirmed
 * behind a modal that stays up until the write resolves, so nothing else on
 * the page is reachable while it is out; the composer is not modal, and
 * posting then immediately switching tabs is an ordinary thing to do.
 */
describe("ForgePage writes across a view change", () => {
  it("still shows the tab the user switched to while a write was in flight", async () => {
    const user = userEvent.setup()
    let releasePrs: (page: ForgeIssueList) => void = () => {}
    let releaseComment: (comment: ForgeComment) => void = () => {}
    vi.mocked(forgeListIssues).mockImplementation((_folder, query) => {
      if (query.tab === "prs") {
        return new Promise<ForgeIssueList>((resolve) => {
          releasePrs = resolve
        })
      }
      return Promise.resolve(listOf([{ ...issue(1, "an issue"), comments: 4 }]))
    })
    vi.mocked(forgeListComments).mockResolvedValue({
      comments: [],
      page: 1,
      per_page: 20,
      has_next: false,
    })
    vi.mocked(forgeCreateComment).mockReturnValue(
      new Promise<ForgeComment>((resolve) => {
        releaseComment = resolve
      })
    )
    mount()
    await user.click(await screen.findByRole("button", { name: "an issue" }))
    await screen.findByPlaceholderText("Leave a comment…")

    // The comment is out and has not come back.
    await user.type(screen.getByPlaceholderText("Leave a comment…"), "hi")
    await user.click(screen.getByRole("button", { name: "Comment" }))
    // Meanwhile the user switches to the other tab; its list goes out too.
    await user.click(screen.getByRole("tab", { name: /Pull requests/ }))
    await waitFor(() =>
      expect(
        vi.mocked(forgeListIssues).mock.calls.some(([, q]) => q.tab === "prs")
      ).toBe(true)
    )

    // The write lands first…
    await act(async () => {
      releaseComment({
        id: "9",
        author: "octocat",
        author_avatar: null,
        body: "hi",
        created_at: null,
        updated_at: null,
        html_url: null,
      })
    })
    // …and then the tab's own list, which the write must not have eaten.
    await act(async () => {
      releasePrs(listOf([{ ...issue(9, "a pull request"), is_pr: true }]))
    })

    expect(
      await screen.findByRole("button", { name: "a pull request" })
    ).toBeInTheDocument()
    // Settled, not stuck on a skeleton or dimmed over a load nothing is doing.
    expect(document.querySelector("[aria-busy='true']")).toBeNull()
    // And the comment was still counted onto the item it was written on.
    expect(
      within(screen.getByRole("dialog")).getByText("5 comments")
    ).toBeInTheDocument()
  })
})

/**
 * The panel deliberately outlives its row: a filter change or a page turn
 * takes the row away without saying anything about the ITEM, and blanking a
 * panel somebody is reading would be worse. Writes made from it still have to
 * survive a list response that predates them — including the SECOND one.
 */
describe("ForgePage writes from a panel with no row", () => {
  it("keeps both comments when two land on an item the list no longer shows", async () => {
    const user = userEvent.setup()
    const resolvers: ((comment: ForgeComment) => void)[] = []
    vi.mocked(forgeListComments).mockResolvedValue({
      comments: [],
      page: 1,
      per_page: 20,
      has_next: false,
    })
    vi.mocked(forgeCreateComment).mockImplementation(
      () =>
        new Promise<ForgeComment>((resolve) => {
          resolvers.push(resolve)
        })
    )
    const listed = { ...issue(1, "a row"), comments: 4 }
    vi.mocked(forgeListIssues).mockResolvedValue(listOf([listed]))
    mount()
    await user.click(await screen.findByRole("button", { name: "a row" }))
    await screen.findByPlaceholderText("Leave a comment…")

    // The row leaves the page: a search narrows the list to nothing, and the
    // panel stays open on the item it was reading.
    vi.mocked(forgeListIssues).mockResolvedValue(listOf([]))
    await user.type(
      screen.getByPlaceholderText("Search title and description…"),
      "zzz"
    )
    await waitFor(
      () =>
        expect(
          screen.queryByRole("button", { name: "a row" })
        ).not.toBeInTheDocument(),
      // Explicit, because this wait is gated on a delay the page means to take:
      // `SEARCH_DEBOUNCE_MS` (350) has to elapse after the last keystroke before
      // the request even goes out. The default 1000ms budget leaves ~600ms for
      // typing, the round trip and the re-render, which is enough right up until
      // it is not — and then it fails as a function of how much ran BEFORE it,
      // in a test that has nothing to do with any of that.
      //
      // Kept well under vitest's 5000ms testTimeout on purpose: at or above it
      // the TEST dies first, which reports a bare timeout instead of the
      // assertion, and hides whatever the row was actually still doing.
      { timeout: 2500 }
    )

    // A list request goes out that WILL come back holding the item again —
    // and is left in flight across both comments. One promise PER call, so
    // releasing it resolves that request and not a later one: a request issued
    // after a write is the user asking again, and its answer is meant to
    // supersede the write (see `reconcile`), which is not what is under test.
    const listResolvers: ((page: ForgeIssueList) => void)[] = []
    vi.mocked(forgeListIssues).mockImplementation(
      () =>
        new Promise<ForgeIssueList>((resolve) => {
          listResolvers.push(resolve)
        })
    )
    await user.clear(
      screen.getByPlaceholderText("Search title and description…")
    )
    await waitFor(() => expect(listResolvers.length).toBeGreaterThan(0))

    const post = async (body: string) => {
      await user.type(screen.getByPlaceholderText("Leave a comment…"), body)
      await user.click(screen.getByRole("button", { name: "Comment" }))
      await waitFor(() => expect(resolvers.length).toBeGreaterThan(0))
      const resolve = resolvers.shift()!
      await act(async () => {
        resolve({
          id: body,
          author: "octocat",
          author_avatar: null,
          body,
          created_at: null,
          updated_at: null,
          html_url: null,
        })
      })
    }
    await post("one")
    await post("two")

    const panel = screen.getByRole("dialog")
    expect(within(panel).getByText("6 comments")).toBeInTheDocument()

    // The stale response lands, still counting four. Reconciliation owes it
    // BOTH increments — recording only the first would roll the panel back.
    await act(async () => {
      listResolvers[listResolvers.length - 1](listOf([listed]))
    })
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "a row" })).toBeInTheDocument()
    )
    expect(
      within(screen.getByRole("dialog")).getByText("6 comments")
    ).toBeInTheDocument()
  })
})
