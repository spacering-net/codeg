/**
 * The right-side detail panel the row's title now opens.
 *
 * What matters beyond plain rendering: the body goes through the Markdown
 * renderer rather than being printed as source, the panel shows EVERY label
 * (the row has to drop all but four), the discussion is fetched for the item
 * on show and paged through in place, and the footer offers the same
 * three-state action the row does — with the way out to the forge kept as a
 * real link.
 */
import { useImperativeHandle, type ReactNode, type Ref } from "react"
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
import type {
  ForgeChangeDetail,
  ForgeChangedFile,
  ForgeChangedFileList,
  ForgeCheck,
  ForgeComment,
  ForgeCommentList,
  ForgeExpectedRepo,
  ForgeIdentity,
  ForgeIssueRow,
  ForgeLabel,
  ForgeMergeOptions,
  ForgeTaskLink,
  WorkTaskStatus,
} from "@/lib/types"

import { ForgeIssueDetailSheet } from "./forge-issue-detail-sheet"

const setRoute = vi.fn()
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({
    routeId: "forge",
    isConversations: false,
    setRoute,
    openConversations: vi.fn(),
  }),
}))
// The real one reaches the workspace context (link safety routes file links
// into the file panel), which this panel is mounted outside of. The stub keeps
// the assertion honest where it counts: it reports WHAT it was handed — body
// and typography both — so a panel that stopped sending either through the
// renderer would fail.
vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({
    children,
    className,
  }: {
    children?: string
    className?: string
  }) => (
    <div data-testid="markdown" className={className}>
      {children}
    </div>
  ),
}))
const forgeListComments = vi.hoisted(() => vi.fn())
const forgeCreateComment = vi.hoisted(() => vi.fn())
const forgeSetItemState = vi.hoisted(() => vi.fn())
const forgeChangeDetail = vi.hoisted(() => vi.fn())
const forgeChangeFiles = vi.hoisted(() => vi.fn())
const forgeMergeOptions = vi.hoisted(() => vi.fn())
const forgeMergeChange = vi.hoisted(() => vi.fn())
const forgeIdentity = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api", () => ({
  forgeListComments,
  forgeCreateComment,
  forgeSetItemState,
  forgeChangeDetail,
  forgeChangeFiles,
  forgeMergeOptions,
  forgeMergeChange,
  forgeIdentity,
}))
const toastError = vi.hoisted(() => vi.fn())
const toastSuccess = vi.hoisted(() => vi.fn())
vi.mock("sonner", () => ({
  toast: { error: toastError, success: toastSuccess },
}))

/**
 * The geometry the virtualized thread reads, and the scroll it reads it from.
 *
 * jsdom lays nothing out, so the numbers a real virtualizer would measure have
 * to be supplied: `scrollSize` is how tall the loaded comments come to and
 * `viewportSize` how much of them fits. `scroll()` is the gesture itself — the
 * only way to reach the auto-load path, because a scroll event in jsdom moves
 * nothing and virtua would report zero for everything anyway.
 */
const virtuaCtl = vi.hoisted(() => ({
  scrollSize: 0,
  viewportSize: 0,
  onScroll: null as ((offset: number) => void) | null,
  /** The `startMargin` the panel last measured — see the assertion on it. */
  startMargin: 0,
}))

/**
 * Every row, not a window.
 *
 * virtua renders ZERO rows under jsdom (it windows from a viewport that is
 * always 0px tall), which would take the whole discussion out of every
 * assertion in this file. The established stand-in — see the
 * model-option-list / logs-settings / sidebar-conversation-list tests — renders
 * the lot, and is exactly why the windowing itself needs manual QA on a long
 * thread.
 *
 * The `as` / `item` tags are honoured rather than flattened, so the list stays
 * a list here as it does in a browser. `ref` is a plain prop (React 19), which
 * is how the real one types it too.
 */
vi.mock("virtua", () => ({
  Virtualizer: ({
    data,
    children,
    as: Container = "div",
    item: Item = "div",
    startMargin = 0,
    onScroll,
    ref,
  }: {
    data: unknown[]
    children: (row: unknown, index: number) => ReactNode
    as?: "ol" | "div"
    item?: "li" | "div"
    startMargin?: number
    onScroll?: (offset: number) => void
    ref?: Ref<unknown>
  }) => {
    virtuaCtl.onScroll = onScroll ?? null
    virtuaCtl.startMargin = startMargin
    useImperativeHandle(ref, () => ({
      get scrollSize() {
        return virtuaCtl.scrollSize
      },
      get viewportSize() {
        return virtuaCtl.viewportSize
      },
      get scrollOffset() {
        return 0
      },
      findItemIndex: () => 0,
      getItemOffset: () => 0,
      getItemSize: () => 0,
      scrollToIndex: () => {},
      scrollTo: () => {},
      scrollBy: () => {},
    }))
    return (
      <Container>
        {data.map((rowData, index) => (
          <Item key={index}>{children(rowData, index)}</Item>
        ))}
      </Container>
    )
  },
}))

function comment(overrides: Partial<ForgeComment> = {}): ForgeComment {
  return {
    id: "1",
    author: "octocat",
    author_avatar: null,
    body: "Looks right to me",
    created_at: "2026-08-20T00:00:00Z",
    updated_at: null,
    html_url: "https://github.com/o/r/issues/42#issuecomment-1",
    ...overrides,
  }
}

function commentPage(
  comments: ForgeComment[],
  hasNext = false,
  page = 1
): ForgeCommentList {
  return { comments, page, per_page: 20, has_next: hasNext }
}

function label(name: string, color: string | null = null): ForgeLabel {
  return { name, color }
}

function row(overrides: Partial<ForgeIssueRow> = {}): ForgeIssueRow {
  return {
    number: 42,
    title: "Login times out",
    body: "## Steps\n\n1. Sign in",
    state: "open",
    draft: false,
    labels: [label("bug")],
    author: "octocat",
    author_avatar: "https://avatars.githubusercontent.com/u/583231",
    updated_at: null,
    html_url: "https://github.com/o/r/issues/42",
    is_pr: false,
    comments: 0,
    ...overrides,
  }
}

function changedFile(
  overrides: Partial<ForgeChangedFile> = {}
): ForgeChangedFile {
  return {
    path: "src/a.rs",
    previous_path: null,
    status: "modified",
    additions: 10,
    deletions: 2,
    binary: false,
    patch: "@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n",
    ...overrides,
  }
}

function filePage(
  files: ForgeChangedFile[],
  hasNext = false
): ForgeChangedFileList {
  return { files, page: 1, per_page: 50, has_next: hasNext }
}

/**
 * A change is read through tabs, and a pane is not even MOUNTED until its tab
 * has been opened — so anything but the discussion has to be asked for here
 * first, exactly as a reader would.
 *
 * Matched on the label's start because a tab carries a badge: "Checks" is
 * "Checks 1 failing" to a screen reader, and "Files changed" is "Files
 * changed 3".
 */
async function openTab(
  user: ReturnType<typeof userEvent.setup>,
  label: "Conversation" | "Checks" | "Files changed"
) {
  await user.click(screen.getByRole("tab", { name: new RegExp(`^${label}`) }))
}

/**
 * Queries scoped to the pane ON SHOW.
 *
 * Every pane stays mounted once visited, so a bare `screen.getByText` reads
 * straight through the tab you are not on — and the merge box and the checks
 * strip deliberately say some of the same things ("1 failing", "Checking
 * whether it can be merged…") on two different tabs. `getByRole` is what
 * distinguishes them: the inactive panes carry `hidden`, so they are out of the
 * accessibility tree and only the live `tabpanel` comes back.
 */
function pane() {
  return within(screen.getByRole("tabpanel"))
}

function taskLink(status: WorkTaskStatus): ForgeTaskLink {
  return {
    source_key: "github:github.com/o/r/issue/42",
    task_id: 3,
    status,
    verdict: null,
    updated_at: "2026-08-19T00:00:00Z",
  }
}

function mount(
  item: ForgeIssueRow | null,
  link: ForgeTaskLink | null = null,
  handlers: {
    onOpenChange?: () => void
    onStart?: () => void
    onRowUpdated?: (updated: ForgeIssueRow) => void
    onCommentPosted?: (item: { isPr: boolean; number: number }) => void
    folderId?: number | null
    repo?: string | null
    /** The pair a write carries — the repository the panel is showing. */
    expected?: ForgeExpectedRepo | null
    /** Called when a write comes back refused as stale. */
    onStaleRepository?: () => void
  } = {}
) {
  const onOpenChange = handlers.onOpenChange ?? vi.fn()
  const onStart = handlers.onStart ?? vi.fn()
  const onRowUpdated = handlers.onRowUpdated ?? vi.fn()
  const onCommentPosted = handlers.onCommentPosted ?? vi.fn()
  const onStaleRepository = handlers.onStaleRepository ?? vi.fn()
  const view = render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ForgeIssueDetailSheet
        row={item}
        link={link}
        folderId={handlers.folderId === undefined ? 7 : handlers.folderId}
        repo={handlers.repo}
        expected={handlers.expected}
        onStaleRepository={onStaleRepository}
        onOpenChange={onOpenChange}
        onStart={onStart}
        onRowUpdated={onRowUpdated}
        onCommentPosted={onCommentPosted}
      />
    </NextIntlClientProvider>
  )
  return {
    onOpenChange,
    onStart,
    onRowUpdated,
    onCommentPosted,
    onStaleRepository,
    view,
  }
}

/**
 * The panel as the PAGE renders it, repository included.
 *
 * The remote is a page-level fact handed down (see `repoKey` in
 * `forge-page.tsx`), so the only way to rehearse a switch of it is to re-render
 * this panel with another value — the folder does not move.
 */
function panelWithRepo(
  item: ForgeIssueRow | null,
  folderId: number,
  repo: string | null
) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ForgeIssueDetailSheet
        row={item}
        link={null}
        folderId={folderId}
        repo={repo}
        onOpenChange={vi.fn()}
        onStart={vi.fn()}
        onRowUpdated={vi.fn()}
        onCommentPosted={vi.fn()}
      />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  // A thread that fits its pane, so nothing auto-loads unless a case says so:
  // the trigger is "the viewport bottom is within 800px of the list's end", and
  // an unset geometry (0/0) satisfies it on the first scroll.
  virtuaCtl.scrollSize = 10_000
  virtuaCtl.viewportSize = 600
  virtuaCtl.onScroll = null
  virtuaCtl.startMargin = 0
  // Still in flight, by default: mounting the panel always asks for the
  // thread, and a request that RESOLVES would land its state update after a
  // test that never awaited it had finished — an `act(…)` warning on every
  // case that is about the header or the footer. The tests that are about the
  // discussion say what comes back for themselves.
  forgeListComments.mockReturnValue(new Promise(() => {}))
  // Same rule for the change section: a pull request always asks for both, and
  // a request that resolved would update state after a test about something
  // else had finished. The cases that are ABOUT the change say so themselves.
  forgeChangeDetail.mockReturnValue(new Promise(() => {}))
  forgeChangeFiles.mockReturnValue(new Promise(() => {}))
  // And for the merge box's own repository lookup, which every OPEN change
  // fires. The merge cases resolve it themselves.
  forgeMergeOptions.mockReturnValue(new Promise(() => {}))
  // And the composer's "posting as" lookup, which every mount with a folder
  // fires. Same rule once more: the cases that are about the avatar resolve it
  // themselves and wait for it.
  forgeIdentity.mockReturnValue(new Promise(() => {}))
})

describe("ForgeIssueDetailSheet", () => {
  /** `null` is the closed state — the page clears the row to close. */
  it("renders nothing without an item", () => {
    mount(null)
    expect(screen.queryByText("Login times out")).not.toBeInTheDocument()
  })

  it("renders the item's body as Markdown, not as source", () => {
    mount(row())
    expect(screen.getByTestId("markdown")).toHaveTextContent("## Steps")
    expect(screen.queryByText("No description")).not.toBeInTheDocument()
  })

  /**
   * The panel's typography goes to the RENDERER, not to a box around it.
   *
   * It has to, for the list indent to mean anything: the shared renderer sets
   * its own, and from a wrapper the two would be descendant selectors of equal
   * specificity settled by Tailwind's emission order. Handed to the renderer,
   * `cn` drops the one being replaced. Nothing about that is visible under
   * jsdom, and putting the classes back on the wrapper would look like a
   * tidy-up.
   */
  it("hands the body's typography to the renderer, list indent included", async () => {
    forgeListComments.mockResolvedValue(
      commentPage([comment({ body: "- one\n- two" })])
    )
    mount(row())

    // The description, and the one comment once the thread lands.
    await waitFor(() =>
      expect(screen.getAllByTestId("markdown")).toHaveLength(2)
    )
    for (const el of screen.getAllByTestId("markdown")) {
      expect(el.className).toContain("[&_ul]:pl-5")
      expect(el.className).toContain("[&_ol]:pl-5")
    }
  })

  /** An empty body must not leave the panel looking like it failed to load.
   *  Whitespace counts as empty — GitLab hands back "" for a description that
   *  was never written, GitHub `null`. */
  it.each([
    ["null", null],
    ["empty", ""],
    ["blank", "   \n  "],
  ])("says so when the body is %s", (_case, body) => {
    mount(row({ body }))
    expect(screen.getByText("No description")).toBeInTheDocument()
    expect(screen.queryByTestId("markdown")).not.toBeInTheDocument()
  })

  /** The row caps labels at four so the action stays on screen; the panel is
   *  where the dropped ones are finally readable. */
  it("shows every label, not the row's first four", () => {
    mount(row({ labels: ["a", "b", "c", "d", "e"].map((n) => label(n)) }))
    for (const name of ["a", "b", "c", "d", "e"]) {
      expect(screen.getByText(name)).toBeInTheDocument()
    }
  })

  /** The state is a glyph on the row, where a column of them reads at a
   *  glance. A single item has no column to compare against, so the panel
   *  spells the state out — and the glyph beside it becomes decoration, or a
   *  screen reader would say the word twice. */
  it("spells the state out beside the title", () => {
    mount(row({ is_pr: true, state: "merged" }))
    expect(screen.getByText("Merged")).toBeInTheDocument()
    expect(
      screen.queryByRole("img", { name: "Merged" })
    ).not.toBeInTheDocument()
  })

  it("keeps the forge one click away as a real link", () => {
    mount(row())
    const link = screen.getByRole("link", { name: "Open in browser" })
    expect(link).toHaveAttribute("href", "https://github.com/o/r/issues/42")
    expect(link).toHaveAttribute("target", "_blank")
  })

  it("offers Start when no task has ever handled the item", async () => {
    const user = userEvent.setup()
    const { onStart } = mount(row())
    await user.click(screen.getByRole("button", { name: "Start" }))
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(setRoute).not.toHaveBeenCalled()
  })

  it("shows a live task's status chip, which goes to the board", async () => {
    const user = userEvent.setup()
    const { onStart } = mount(row(), taskLink("running"))
    expect(
      screen.queryByRole("button", { name: "Start" })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "re-trigger" })
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Running" }))
    expect(setRoute).toHaveBeenCalledWith("tasks")
    expect(onStart).not.toHaveBeenCalled()
  })

  /** Same rule as the row: siblings, never nested — a control inside a button
   *  folds its text into that button's accessible name. */
  it("keeps the chip and the re-trigger as separate controls once settled", async () => {
    const user = userEvent.setup()
    const { onStart } = mount(row(), taskLink("done"))
    const chip = screen.getByRole("button", { name: "Done" })
    const retrigger = screen.getByRole("button", { name: "re-trigger" })
    expect(chip).not.toContainElement(retrigger)

    await user.click(retrigger)
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(setRoute).not.toHaveBeenCalled()
  })

  /** The count sits in the identity line, where it is one more fact about the
   *  item — absent, not zero, when there is no discussion. The thread below
   *  carries its own heading and does not repeat the number: two counts that
   *  can disagree (the row is a snapshot, the thread is live) is worse than
   *  one. */
  it("reports the comment count only when there is a discussion", () => {
    mount(row({ comments: 7 }))
    const header = screen
      .getByText("Login times out")
      .closest("[data-slot='drawer-header']") as HTMLElement
    expect(within(header).getByText("7 comments")).toBeInTheDocument()

    cleanup()
    mount(row({ comments: 0 }))
    const bare = screen
      .getByText("Login times out")
      .closest("[data-slot='drawer-header']") as HTMLElement
    expect(within(bare).queryByText(/comments/i)).not.toBeInTheDocument()
  })

  describe("the discussion", () => {
    /** The item's coordinates, and only those: the repository comes from the
     *  folder's own remote, server-side. */
    it("fetches the thread for the item on show and renders it", async () => {
      forgeListComments.mockResolvedValue(
        commentPage([comment({ body: "Cannot reproduce" })])
      )
      mount(row())

      await waitFor(() =>
        expect(forgeListComments).toHaveBeenCalledWith(7, {
          kind: "issue",
          number: 42,
          page: 1,
        })
      )
      expect(await screen.findByText("octocat")).toBeInTheDocument()
      // Through the Markdown renderer, like the body — a comment is the same
      // kind of forge Markdown.
      const rendered = screen
        .getAllByTestId("markdown")
        .map((el) => el.textContent)
      expect(rendered).toContain("Cannot reproduce")
      expect(
        screen.getByRole("link", { name: "Open this comment in the browser" })
      ).toHaveAttribute(
        "href",
        "https://github.com/o/r/issues/42#issuecomment-1"
      )
    })

    /** GitLab keeps issue notes and merge-request notes on different
     *  endpoints, so the kind travels with the request. */
    it("asks about a pull request as a pull request", async () => {
      mount(row({ is_pr: true, number: 9 }))
      await waitFor(() =>
        expect(forgeListComments).toHaveBeenCalledWith(7, {
          kind: "pr",
          number: 9,
          page: 1,
        })
      )
    })

    it("says so when nobody has replied", async () => {
      forgeListComments.mockResolvedValue(commentPage([]))
      mount(row())
      expect(await screen.findByText("No comments yet")).toBeInTheDocument()
      expect(
        screen.queryByRole("button", { name: "Load more" })
      ).not.toBeInTheDocument()
    })

    /** Offset pagination over a live collection: a comment posted between the
     *  two requests shifts everything down one and serves the last of page 1
     *  again at the top of page 2. It must appear once. */
    it("appends the next page without repeating what is already on screen", async () => {
      const user = userEvent.setup()
      const first = comment({ id: "1", body: "first" })
      const second = comment({ id: "2", body: "second" })
      forgeListComments
        .mockResolvedValueOnce(commentPage([first, second], true, 1))
        .mockResolvedValueOnce(
          commentPage([second, comment({ id: "3", body: "third" })], false, 2)
        )
      mount(row())

      await screen.findByText("first")
      await user.click(screen.getByRole("button", { name: "Load more" }))

      await screen.findByText("third")
      expect(forgeListComments).toHaveBeenLastCalledWith(7, {
        kind: "issue",
        number: 42,
        page: 2,
      })
      // The one that arrived twice is on screen once, and the page already
      // read is still there.
      expect(screen.getAllByText("second")).toHaveLength(1)
      expect(screen.getByText("first")).toBeInTheDocument()
      expect(
        screen.queryByRole("button", { name: "Load more" })
      ).not.toBeInTheDocument()
    })

    /** GitLab filters its system events ("changed the milestone") AFTER
     *  paginating, so a page can come back holding nothing a human wrote while
     *  the discussion continues on the next one. "Load more" follows the
     *  forge's own `has_next`, never the row count. */
    it("still offers more when a page held only system events", async () => {
      forgeListComments.mockResolvedValue(commentPage([], true, 1))
      mount(row())

      expect(
        await screen.findByRole("button", { name: "Load more" })
      ).toBeInTheDocument()
      expect(screen.queryByText("No comments yet")).not.toBeInTheDocument()
    })

    /** A failed "load more" costs the rest of the thread, not the part being
     *  read — and the retry re-asks for the page that FAILED. */
    it("keeps the loaded pages when the next one fails, and retries that page", async () => {
      const user = userEvent.setup()
      forgeListComments
        .mockResolvedValueOnce(
          commentPage([comment({ id: "1", body: "first" })], true, 1)
        )
        .mockRejectedValueOnce(new Error("network is down"))
        .mockResolvedValueOnce(
          commentPage([comment({ id: "2", body: "later" })], false, 2)
        )
      mount(row())

      await screen.findByText("first")
      await user.click(screen.getByRole("button", { name: "Load more" }))
      expect(await screen.findByText(/network is down/)).toBeInTheDocument()
      expect(screen.getByText("first")).toBeInTheDocument()

      await user.click(screen.getByRole("button", { name: "Try again" }))
      await screen.findByText("later")
      // Page 2 again — not 3 (which would skip it) and not 1 (which would
      // throw away what is on screen).
      expect(forgeListComments).toHaveBeenLastCalledWith(7, {
        kind: "issue",
        number: 42,
        page: 2,
      })
    })

    /** The retry re-asks for the page that FAILED, and a refresh is page 1 no
     *  matter how far the thread had been paged. Deriving the retry from the
     *  "load more" cursor instead would ask for the page AFTER the one on
     *  screen and append it to the very data the refresh was there to replace. */
    it("retries a failed refresh as a refresh, not as another page", async () => {
      const user = userEvent.setup()
      forgeListComments
        .mockResolvedValueOnce(
          commentPage([comment({ id: "1", body: "stale" })], true, 1)
        )
        .mockRejectedValueOnce(new Error("refresh fell over"))
        .mockResolvedValueOnce(
          commentPage([comment({ id: "2", body: "fresh" })], false, 1)
        )
      mount(row())

      await screen.findByText("stale")
      await user.click(
        screen.getByRole("button", { name: "Refresh the comments" })
      )
      expect(await screen.findByText(/refresh fell over/)).toBeInTheDocument()

      await user.click(screen.getByRole("button", { name: "Try again" }))
      await screen.findByText("fresh")
      expect(forgeListComments).toHaveBeenLastCalledWith(7, {
        kind: "issue",
        number: 42,
        page: 1,
      })
      // Page 1 REPLACES — the stale copy the refresh was sent for is gone,
      // rather than sitting above an appended page 2.
      expect(screen.queryByText("stale")).not.toBeInTheDocument()
    })

    /** Both forges stamp an `updated_at` on creation, so the backend sends one
     *  only when it differs. The panel must not invent the mark for itself. */
    it("marks an edited comment, and only an edited one", async () => {
      forgeListComments.mockResolvedValue(
        commentPage([
          comment({ id: "1", body: "untouched" }),
          comment({
            id: "2",
            body: "revised",
            updated_at: "2026-08-21T00:00:00Z",
          }),
        ])
      )
      mount(row())
      expect(await screen.findByText(/edited/)).toBeInTheDocument()
      expect(screen.getAllByText(/edited/)).toHaveLength(1)
    })

    /** Back to page 1 wholesale: an edited or deleted comment is a change no
     *  append could show, so a refresh REPLACES rather than doubling. */
    it("refreshes the thread from the top", async () => {
      const user = userEvent.setup()
      forgeListComments
        .mockResolvedValueOnce(commentPage([comment({ id: "1", body: "old" })]))
        .mockResolvedValueOnce(commentPage([comment({ id: "9", body: "new" })]))
      mount(row())

      await screen.findByText("old")
      await user.click(
        screen.getByRole("button", { name: "Refresh the comments" })
      )

      await screen.findByText("new")
      expect(screen.queryByText("old")).not.toBeInTheDocument()
      expect(forgeListComments).toHaveBeenLastCalledWith(7, {
        kind: "issue",
        number: 42,
        page: 1,
      })
    })

    /** The panel is non-modal, so clicking another row swaps the item under it
     *  without ever closing — the thread has to follow. */
    it("follows the panel to another item", async () => {
      const { view } = mount(row())
      await waitFor(() =>
        expect(forgeListComments).toHaveBeenCalledWith(
          7,
          expect.objectContaining({ number: 42 })
        )
      )
      view.rerender(
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <ForgeIssueDetailSheet
            row={row({ number: 43, title: "Another one" })}
            link={null}
            folderId={7}
            onOpenChange={vi.fn()}
            onStart={vi.fn()}
            onRowUpdated={vi.fn()}
            onCommentPosted={vi.fn()}
          />
        </NextIntlClientProvider>
      )
      await waitFor(() =>
        expect(forgeListComments).toHaveBeenLastCalledWith(
          7,
          expect.objectContaining({ number: 43, page: 1 })
        )
      )
    })

    /** A re-render that changes nothing about the item — the page re-reads the
     *  row from the list on every one — must not re-fetch, or a refresh behind
     *  the panel would reset the thread and scroll the reader to the top. */
    it("does not re-fetch when the row object is merely replaced", async () => {
      const { view } = mount(row())
      await waitFor(() => expect(forgeListComments).toHaveBeenCalledTimes(1))
      view.rerender(
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <ForgeIssueDetailSheet
            row={row({ title: "Login times out (edited)" })}
            link={null}
            folderId={7}
            onOpenChange={vi.fn()}
            onStart={vi.fn()}
            onRowUpdated={vi.fn()}
            onCommentPosted={vi.fn()}
          />
        </NextIntlClientProvider>
      )
      await screen.findByText("Login times out (edited)")
      expect(forgeListComments).toHaveBeenCalledTimes(1)
    })

    /** No folder, no repository to ask about — the panel keeps everything the
     *  row already carries rather than showing a thread it cannot fetch. */
    it("skips the thread when no folder is resolved", async () => {
      mount(row(), null, { folderId: null })
      await screen.findByText("Login times out")
      expect(forgeListComments).not.toHaveBeenCalled()
      expect(screen.queryByText("Comments")).not.toBeInTheDocument()
    })

    /**
     * The thread is windowed, and reading it to the end asks for the rest.
     *
     * Only the DECISION is testable here: virtua is mocked away (see the top of
     * this file), so these drive the scroll callback with the geometry a real
     * one would have reported. Whether the window itself is drawn correctly —
     * and whether the measured `startMargin` puts it under the description
     * rather than through it — is manual QA on a real thread.
     */
    describe("scrolling to the end of it", () => {
      /** The offset that puts the viewport's bottom edge inside the 800px
       *  trigger distance of the list's end, and one that leaves it well
       *  short. `startMargin` is 0 under jsdom (nothing is laid out), so the
       *  list's end is `scrollSize` alone. */
      const NEAR_END = 10_000 - 600 - 700
      const MIDWAY = 1_000

      /** Drives one scroll event through the mocked virtualizer, wrapped
       *  because the fetch it may start updates state. */
      async function scrollTo(offset: number) {
        await act(async () => {
          virtuaCtl.onScroll?.(offset)
        })
      }

      it("loads the next page as the reader nears the last comment", async () => {
        forgeListComments
          .mockResolvedValueOnce(
            commentPage([comment({ id: "1", body: "first" })], true, 1)
          )
          .mockResolvedValueOnce(
            commentPage([comment({ id: "2", body: "second" })], false, 2)
          )
        mount(row())
        await screen.findByText("first")

        await scrollTo(NEAR_END)
        expect(await screen.findByText("second")).toBeInTheDocument()
        expect(forgeListComments).toHaveBeenLastCalledWith(7, {
          kind: "issue",
          number: 42,
          page: 2,
        })
      })

      it("leaves the rest alone while the reader is still in the middle", async () => {
        forgeListComments.mockResolvedValue(
          commentPage([comment({ id: "1", body: "first" })], true, 1)
        )
        mount(row())
        await screen.findByText("first")
        expect(forgeListComments).toHaveBeenCalledTimes(1)

        await scrollTo(MIDWAY)
        expect(forgeListComments).toHaveBeenCalledTimes(1)
      })

      /** `has_next: false` is the end of the thread. Reaching the bottom of a
       *  fully-loaded discussion must not keep asking the forge for a page it
       *  has already said does not exist. */
      it("asks for nothing once the forge says there is no more", async () => {
        forgeListComments.mockResolvedValue(
          commentPage([comment({ id: "1", body: "only" })], false, 1)
        )
        mount(row())
        await screen.findByText("only")
        expect(forgeListComments).toHaveBeenCalledTimes(1)

        await scrollTo(NEAR_END)
        expect(forgeListComments).toHaveBeenCalledTimes(1)
      })

      /**
       * One page per gesture, not one per frame.
       *
       * A scroll fires an event on every frame it moves, and virtua hands over
       * whichever callback its own effect last committed — which for the frame
       * after a fetch starts is still the one that was built when nothing was
       * in flight. Without the in-flight flag this is three requests for page
       * 2, and the last to land wins.
       */
      it("asks for the page once however many scroll events arrive", async () => {
        forgeListComments.mockResolvedValueOnce(
          commentPage([comment({ id: "1", body: "first" })], true, 1)
        )
        // Never settles, so every later event arrives with the fetch still out.
        forgeListComments.mockReturnValue(new Promise(() => {}))
        mount(row())
        await screen.findByText("first")
        expect(forgeListComments).toHaveBeenCalledTimes(1)

        await scrollTo(NEAR_END)
        await scrollTo(NEAR_END + 1)
        await scrollTo(NEAR_END + 2)
        expect(forgeListComments).toHaveBeenCalledTimes(2)
      })

      /**
       * A broken network is the one thing that must NOT be retried by reading.
       *
       * The reader is already at the end of the thread when a page fails, so
       * every further scroll event is another attempt — and the strip that says
       * what went wrong would never be on screen long enough to read. Recovery
       * stays on its "Try again".
       */
      it("stops asking once a page has failed, and resumes from the retry", async () => {
        const user = userEvent.setup()
        forgeListComments
          .mockResolvedValueOnce(
            commentPage([comment({ id: "1", body: "first" })], true, 1)
          )
          .mockRejectedValueOnce(new Error("offline"))
          .mockResolvedValueOnce(
            commentPage([comment({ id: "2", body: "second" })], false, 2)
          )
        mount(row())
        await screen.findByText("first")

        await scrollTo(NEAR_END)
        await screen.findByText("offline")
        expect(forgeListComments).toHaveBeenCalledTimes(2)

        await scrollTo(NEAR_END + 1)
        await scrollTo(NEAR_END + 2)
        expect(forgeListComments).toHaveBeenCalledTimes(2)

        await user.click(screen.getByRole("button", { name: "Try again" }))
        expect(await screen.findByText("second")).toBeInTheDocument()
        // The page that FAILED, not the one after it.
        expect(forgeListComments).toHaveBeenNthCalledWith(3, 7, {
          kind: "issue",
          number: 42,
          page: 2,
        })
      })

      /** Windowing is a rendering technique, not a licence to stop being a
       *  list: virtua takes the tags rather than wrapping them, so a screen
       *  reader still hears "list, 2 items". */
      it("stays a list of list items", async () => {
        forgeListComments.mockResolvedValue(
          commentPage([
            comment({ id: "1", body: "first" }),
            comment({ id: "2", body: "second" }),
          ])
        )
        mount(row())
        await screen.findByText("first")

        const list = screen.getByRole("list")
        expect(list.tagName).toBe("OL")
        expect(within(list).getAllByRole("listitem")).toHaveLength(2)
      })
    })
  })

  /** The page owns the open state (it holds the row), so every exit has to
   *  travel back out through `onOpenChange` — a panel that only closed itself
   *  internally would leave the page thinking it was still open. `close-press`
   *  rather than `anything()`: the drawer wrapper cancels ambient dismissals,
   *  so only that reason proves the button is really wired. */
  it("asks the page to close from the close button and from Escape", async () => {
    const user = userEvent.setup()
    const { onOpenChange } = mount(row())
    await user.click(screen.getByRole("button", { name: "Close" }))
    expect(onOpenChange).toHaveBeenCalledWith(
      false,
      expect.objectContaining({ reason: "close-press" })
    )

    cleanup()
    const second = mount(row())
    await user.keyboard("{Escape}")
    expect(second.onOpenChange).toHaveBeenCalledWith(
      false,
      expect.objectContaining({ reason: "escape-key" })
    )
  })

  /** The identity line under the title: the number, who opened it, nothing the
   *  reader has to go looking for elsewhere. */
  it("identifies the item under its title", () => {
    mount(row({ updated_at: "2026-08-20T00:00:00Z" }))
    const title = screen.getByText("Login times out")
    const header = title.closest("[data-slot='drawer-header']")
    expect(header).not.toBeNull()
    expect(within(header as HTMLElement).getByText("· #42")).toBeInTheDocument()
    expect(
      within(header as HTMLElement).getByText("· octocat")
    ).toBeInTheDocument()
    expect(
      within(header as HTMLElement).getByText(/updated/)
    ).toBeInTheDocument()
  })
})

/**
 * The panel WRITES: a comment, and the item's open/closed state.
 *
 * The rule both share is that the FORGE's answer is what lands on screen — not
 * the text that was typed, not a locally flipped `state`. That is what makes
 * the panel survive a pull request somebody merged in the browser a moment
 * ago, and what keeps a posted comment keyed by an id the next page can
 * de-duplicate against.
 */
describe("ForgeIssueDetailSheet writes", () => {
  it("posts what was typed and appends the comment the forge stored", async () => {
    const user = userEvent.setup()
    forgeListComments.mockResolvedValue(commentPage([]))
    // NOT an echo of the draft: a different id, a different author, and a
    // permalink — the three things the thread keys, de-duplicates and links by.
    forgeCreateComment.mockResolvedValue(
      comment({ id: "991", author: "alice", body: "looks fixed" })
    )
    const { onCommentPosted } = mount(row())
    await screen.findByText("No comments yet")

    const box = screen.getByPlaceholderText("Leave a comment…")
    await user.type(box, "  looks fixed  ")
    await user.click(screen.getByRole("button", { name: "Comment" }))

    await waitFor(() =>
      expect(forgeCreateComment).toHaveBeenCalledWith(
        7,
        {
          kind: "issue",
          number: 42,
          // Trimmed before it goes out — a comment padded with what a keyboard
          // left behind is one nobody meant to publish.
          body: "looks fixed",
        },
        // No repository named by this caller — see the test below for the one
        // that does.
        null
      )
    )
    expect(await screen.findByText("looks fixed")).toBeInTheDocument()
    expect(screen.getByText("alice")).toBeInTheDocument()
    // The draft is cleared only once it exists somewhere else.
    expect(box).toHaveValue("")
    // The ITEM, not a row: a snapshot taken at submit time could carry this
    // item's pre-close state back over a newer one (see `onCommentPosted`).
    expect(onCommentPosted).toHaveBeenCalledWith({ isPr: false, number: 42 })
  })

  it("keeps the draft when the post fails", async () => {
    const user = userEvent.setup()
    forgeListComments.mockResolvedValue(commentPage([]))
    forgeCreateComment.mockRejectedValue(new Error("rate limited"))
    const { onCommentPosted } = mount(row())
    await screen.findByText("No comments yet")

    const box = screen.getByPlaceholderText("Leave a comment…")
    await user.type(box, "worth keeping")
    await user.click(screen.getByRole("button", { name: "Comment" }))

    expect(await screen.findByText("rate limited")).toBeInTheDocument()
    // Losing what somebody wrote to a network failure they cannot retry from
    // is the one outcome a composer must never have.
    expect(box).toHaveValue("worth keeping")
    expect(onCommentPosted).not.toHaveBeenCalled()
  })

  it("will not post an empty comment", async () => {
    const user = userEvent.setup()
    forgeListComments.mockResolvedValue(commentPage([]))
    mount(row())
    await screen.findByText("No comments yet")

    const submit = screen.getByRole("button", { name: "Comment" })
    expect(submit).toBeDisabled()
    // Whitespace is not text: both forges accept it and render a blank card
    // this app has no way to delete.
    await user.type(screen.getByPlaceholderText("Leave a comment…"), "   ")
    expect(submit).toBeDisabled()
  })

  /** What the backend answers with when the coordinates a write carried no
   *  longer match the folder's remote (see `WRITE_MISMATCH_I18N_KEY`). */
  const writeMismatch = {
    code: "configuration_invalid",
    message:
      "this panel was showing github.com/me/app, but the folder's remote is now github.com/acme/app",
    i18n_key: "Forge.writeMismatch",
    i18n_params: {
      expected: "github.com/me/app",
      actual: "github.com/acme/app",
    },
  }

  it("carries the repository this panel is showing on the post", async () => {
    const user = userEvent.setup()
    forgeListComments.mockResolvedValue(commentPage([]))
    forgeCreateComment.mockResolvedValue(comment({ id: "991", body: "hi" }))
    mount(row(), null, {
      expected: {
        expectedServerHost: "github.com",
        expectedOwnerRepo: "me/app",
      },
    })
    await screen.findByText("No comments yet")

    await user.type(screen.getByPlaceholderText("Leave a comment…"), "hi")
    await user.click(screen.getByRole("button", { name: "Comment" }))

    await waitFor(() =>
      expect(forgeCreateComment).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ body: "hi" }),
        { expectedServerHost: "github.com", expectedOwnerRepo: "me/app" }
      )
    )
  })

  it("hands a stale-repository refusal to the page instead of only reporting it", async () => {
    const user = userEvent.setup()
    forgeListComments.mockResolvedValue(commentPage([]))
    forgeCreateComment.mockRejectedValue(writeMismatch)
    const { onStaleRepository, onCommentPosted } = mount(row(), null, {
      expected: {
        expectedServerHost: "github.com",
        expectedOwnerRepo: "me/app",
      },
    })
    await screen.findByText("No comments yet")

    await user.type(
      screen.getByPlaceholderText("Leave a comment…"),
      "meant for the fork"
    )
    await user.click(screen.getByRole("button", { name: "Comment" }))

    // The panel is stale, so re-resolving is the only fix — this is the
    // callback the page turns into one. Nothing was published, and nothing was
    // adopted as if it had been.
    await waitFor(() => expect(onStaleRepository).toHaveBeenCalled())
    expect(onCommentPosted).not.toHaveBeenCalled()
  })

  it("does the same for a close the folder has moved out from under", async () => {
    const user = userEvent.setup()
    forgeSetItemState.mockRejectedValue(writeMismatch)
    const { onStaleRepository, onRowUpdated } = mount(row(), null, {
      expected: {
        expectedServerHost: "github.com",
        expectedOwnerRepo: "me/app",
      },
    })

    await user.click(
      screen.getByRole("button", { name: "Close #42 on the forge" })
    )
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Close",
      })
    )

    await waitFor(() => expect(onStaleRepository).toHaveBeenCalled())
    // Not flipped locally: the write never happened, and pretending it did is
    // the guess this panel refuses to make everywhere else.
    expect(onRowUpdated).not.toHaveBeenCalled()
  })

  it("confirms a close, then adopts the row the forge answered with", async () => {
    const user = userEvent.setup()
    // GitHub's PATCH answers with bare label names on GitLab; here the point
    // is the STATE, which came back as something the caller did not ask for.
    forgeSetItemState.mockResolvedValue(
      row({ state: "closed", labels: [label("bug")] })
    )
    const { onRowUpdated } = mount(row({ labels: [label("bug", "#d73a4a")] }))

    await user.click(
      screen.getByRole("button", { name: "Close #42 on the forge" })
    )
    // Nothing has been sent yet: the dialog is the confirmation.
    expect(forgeSetItemState).not.toHaveBeenCalled()
    expect(await screen.findByText("Close this item?")).toBeInTheDocument()

    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Close",
      })
    )
    await waitFor(() =>
      expect(forgeSetItemState).toHaveBeenCalledWith(
        7,
        {
          kind: "issue",
          number: 42,
          action: "close",
        },
        null
      )
    )
    await waitFor(() => expect(onRowUpdated).toHaveBeenCalled())
    const adopted = vi.mocked(onRowUpdated).mock.calls[0][0] as ForgeIssueRow
    expect(adopted.state).toBe("closed")
    // The colour the single-item payload could not carry is restored from the
    // row the panel already had — otherwise every chip drops to grey the
    // instant somebody presses Close.
    expect(adopted.labels).toEqual([label("bug", "#d73a4a")])
  })

  it("offers reopen on a closed item and nothing at all on a merged one", () => {
    mount(row({ state: "closed" }))
    expect(
      screen.getByRole("button", { name: "Reopen #42 on the forge" })
    ).toBeInTheDocument()
    cleanup()

    // A merged change has no state left to set: GitHub refuses to reopen it
    // and GitLab reopens it against a branch that is gone. A button that can
    // only fail is worse than no button.
    mount(row({ is_pr: true, state: "merged" }))
    expect(
      screen.queryByRole("button", { name: /on the forge/ })
    ).not.toBeInTheDocument()
  })

  it("reports a refused state change without closing the confirmation", async () => {
    const user = userEvent.setup()
    forgeSetItemState.mockRejectedValue(new Error("issue is locked"))
    const { onRowUpdated } = mount(row())

    await user.click(
      screen.getByRole("button", { name: "Close #42 on the forge" })
    )
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Close",
      })
    )
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("issue is locked")
    )
    expect(onRowUpdated).not.toHaveBeenCalled()
    // Still open, so the action can be retried from where it was started.
    expect(screen.getByText("Close this item?")).toBeInTheDocument()
  })
})

/**
 * What a pull request IS, above its discussion — and the three answers the CI
 * section has to keep apart: green, nothing configured, and "this account
 * cannot look".
 */
describe("ForgeIssueDetailSheet change section", () => {
  function change(
    overrides: Partial<ForgeChangeDetail> = {}
  ): ForgeChangeDetail {
    return {
      number: 42,
      base_ref: "main",
      head_ref: "fix/timeout",
      head_repo: null,
      head_sha: "abc123",
      draft: false,
      state: "open",
      mergeable: true,
      merge_state: "clean",
      additions: 120,
      deletions: 8,
      changed_files: 3,
      commits: 2,
      checks: { checks: [], available: true, partial: false },
      ...overrides,
    }
  }

  it("is asked for only on a proposed change", async () => {
    mount(row({ is_pr: false }))
    await waitFor(() => expect(forgeListComments).toHaveBeenCalled())
    // An issue has no branches, no diff and no CI — and asking would spend two
    // upstream requests to be told so.
    expect(forgeChangeDetail).not.toHaveBeenCalled()
    expect(forgeChangeFiles).not.toHaveBeenCalled()
  })

  /** Which branches a change joins is what it IS, so it stays in the header —
   *  readable from every tab rather than behind one of them. */
  it("names the branches in its header, fork and all", async () => {
    forgeChangeDetail.mockResolvedValue(
      change({ head_repo: "contributor/app", draft: true })
    )
    mount(row({ is_pr: true, state: "open", draft: true }))

    expect(await screen.findByText("main")).toBeInTheDocument()
    // The fork is named; a same-repository head would show the branch alone.
    expect(screen.getByText("contributor/app:fix/timeout")).toBeInTheDocument()
    // Once — the meta line directly above already spells the state out, and a
    // second "Draft" beside the branches reads as a second fact.
    expect(screen.getAllByText("Draft")).toHaveLength(1)
  })

  it("counts the change and lists its files, once their tab is opened", async () => {
    const user = userEvent.setup()
    forgeChangeDetail.mockResolvedValue(change())
    forgeChangeFiles.mockResolvedValue(
      filePage([
        changedFile(),
        changedFile({
          path: "logo.png",
          status: "added",
          additions: null,
          deletions: null,
          binary: true,
          patch: null,
        }),
      ])
    )
    mount(row({ is_pr: true, state: "open" }))
    // A page of fifty files now carries fifty patches — nothing is spent on it
    // until somebody asks to see the files.
    await screen.findByText("main")
    expect(forgeChangeFiles).not.toHaveBeenCalled()

    await openTab(user, "Files changed")
    expect(await screen.findByText("src/a.rs")).toBeInTheDocument()
    expect(screen.getByText("3 files")).toBeInTheDocument()
    expect(screen.getByText("2 commits")).toBeInTheDocument()
    expect(screen.getByText("+10")).toBeInTheDocument()
    // A binary file has no line counts on either forge; zeroes would claim it
    // changed nothing.
    expect(screen.getByText("binary")).toBeInTheDocument()
    expect(forgeChangeFiles).toHaveBeenCalledWith(7, { number: 42, page: 1 })
  })

  it("tells 'no checks ran' apart from 'could not look'", async () => {
    const user = userEvent.setup()
    forgeChangeDetail.mockResolvedValue(
      change({ checks: { checks: [], available: true, partial: false } })
    )
    mount(row({ is_pr: true }))
    await openTab(user, "Checks")
    expect(await screen.findByText("No checks ran")).toBeInTheDocument()
    cleanup()

    forgeChangeDetail.mockResolvedValue(
      change({ checks: { checks: [], available: false, partial: false } })
    )
    mount(row({ is_pr: true }))
    await openTab(user, "Checks")
    // Not "no checks": a token without the scope over a red build would
    // otherwise read as a green one.
    expect(
      await screen.findByText(
        "This account cannot read the repository's checks."
      )
    ).toBeInTheDocument()
  })

  it("counts only the check states worth a headline", async () => {
    const user = userEvent.setup()
    forgeChangeDetail.mockResolvedValue(
      change({
        checks: {
          available: true,
          partial: false,
          checks: [
            {
              id: "1",
              name: "build",
              state: "success",
              summary: null,
              url: null,
              allow_failure: false,
            },
            {
              id: "2",
              name: "lint",
              state: "failure",
              summary: "2 problems",
              url: null,
              allow_failure: true,
            },
            {
              id: "3",
              name: "e2e",
              state: "running",
              summary: null,
              url: null,
              allow_failure: false,
            },
            // Skipped is NOT a pass, and it is not a failure either — it must
            // not be counted into either headline.
            {
              id: "4",
              name: "deploy",
              state: "neutral",
              summary: null,
              url: null,
              allow_failure: false,
            },
          ],
        },
      })
    )
    mount(row({ is_pr: true }))
    await openTab(user, "Checks")

    expect(await pane().findByText("1 passing")).toBeInTheDocument()
    expect(pane().getByText("1 failing")).toBeInTheDocument()
    expect(pane().getByText("1 in progress")).toBeInTheDocument()
    // A red job the pipeline tolerates is a different fact from one that
    // blocks the change.
    expect(screen.getByText("may fail")).toBeInTheDocument()
    // Each state carries a translated label, so the strip means something
    // without colour vision.
    expect(screen.getByRole("img", { name: "Failed" })).toBeInTheDocument()
    expect(screen.getByRole("img", { name: "No verdict" })).toBeInTheDocument()
  })

  /**
   * "Can this land" is one question with two halves — whether it merges, and
   * how CI came out — and it used to be asked over two rows, the verdict on
   * one and the tallies on the next, with the reload stranded beside the first.
   */
  it("leads with mergeability and CI on one line, the reload at its end", async () => {
    const user = userEvent.setup()
    forgeChangeDetail.mockResolvedValue(
      change({
        checks: {
          available: true,
          partial: false,
          checks: [
            {
              id: "1",
              name: "build",
              state: "failure",
              summary: null,
              url: null,
              allow_failure: false,
            },
          ],
        },
      })
    )
    mount(row({ is_pr: true }))
    await openTab(user, "Checks")

    const verdict = await pane().findByText("Can be merged")
    const run = verdict.parentElement
    expect(run).not.toBeNull()
    expect(run).toContainElement(pane().getByText("1 failing"))

    // And the reload closes that same row, rather than sitting on one of its
    // own above it.
    const reload = pane().getByRole("button", {
      name: "Refresh the change details",
    })
    expect(run?.parentElement).toContainElement(reload)
    expect(run?.parentElement?.lastElementChild).toBe(reload)
  })

  /** A red build is the one thing about a change nobody should have to go
   *  looking for, so the worst state in the list rides on the tab itself. */
  it("carries the worst check state on the tab, failure over anything still running", async () => {
    forgeChangeDetail.mockResolvedValue(
      change({
        checks: {
          available: true,
          partial: false,
          checks: [
            {
              id: "1",
              name: "build",
              state: "running",
              summary: null,
              url: null,
              allow_failure: false,
            },
            {
              id: "2",
              name: "lint",
              state: "failure",
              summary: null,
              url: null,
              allow_failure: false,
            },
          ],
        },
      })
    )
    mount(row({ is_pr: true }))
    // On the TAB, without its pane ever being opened.
    expect(
      await screen.findByRole("tab", { name: "Checks 1 failing" })
    ).toBeInTheDocument()
    cleanup()

    // Nothing to report is not the same as a clean sweep: a mark for "the
    // forge would not say" is indistinguishable from a mark for "fine".
    forgeChangeDetail.mockResolvedValue(
      change({ checks: { checks: [], available: false, partial: false } })
    )
    mount(row({ is_pr: true }))
    await screen.findByText("main")
    expect(screen.getByRole("tab", { name: "Checks" })).toBeInTheDocument()
  })

  it("says nothing about mergeability it does not know, and nothing at all once merged", async () => {
    const user = userEvent.setup()
    // Both forges answer "not worked out yet" — GitHub with a null, GitLab
    // with `unchecked`. Reading that as "cannot be merged" would send someone
    // hunting a conflict that may not exist.
    forgeChangeDetail.mockResolvedValue(
      change({ mergeable: null, merge_state: "unknown" })
    )
    mount(row({ is_pr: true }))
    await openTab(user, "Checks")
    expect(
      await pane().findByText("Checking whether it can be merged…")
    ).toBeInTheDocument()
    expect(pane().queryByText("Has conflicts")).not.toBeInTheDocument()
    cleanup()

    // Already landed: both forges keep answering the question, and "has
    // conflicts" on something that merged reads as a problem that is not there.
    forgeChangeDetail.mockResolvedValue(
      change({ state: "merged", mergeable: false, merge_state: "dirty" })
    )
    mount(row({ is_pr: true, state: "merged" }))
    expect(await screen.findByText("main")).toBeInTheDocument()
    await openTab(user, "Checks")
    expect(screen.queryByText("Has conflicts")).not.toBeInTheDocument()
    expect(
      screen.queryByText("Checking whether it can be merged…")
    ).not.toBeInTheDocument()
  })

  it("omits the counters the forge did not report", async () => {
    const user = userEvent.setup()
    // A GitLab merge request: no line counts, no commit count, and a
    // `changes_count` the backend refused to trust.
    forgeChangeDetail.mockResolvedValue(
      change({
        additions: null,
        deletions: null,
        commits: null,
        changed_files: null,
      })
    )
    forgeChangeFiles.mockResolvedValue(filePage([]))
    mount(row({ is_pr: true }))
    await openTab(user, "Checks")
    expect(await screen.findByText("Can be merged")).toBeInTheDocument()

    await openTab(user, "Files changed")
    expect(await screen.findByText("No files changed")).toBeInTheDocument()
    // A zero here would claim the change touches nothing — including on the
    // tab, which would otherwise wear a "0" badge.
    expect(screen.queryByText(/files$/)).not.toBeInTheDocument()
    expect(screen.queryByText(/commits$/)).not.toBeInTheDocument()
    expect(screen.queryByText("+0")).not.toBeInTheDocument()
    expect(
      screen.getByRole("tab", { name: "Files changed" })
    ).toBeInTheDocument()
  })
})

/**
 * The panel's own shape: three panes for a change, one scroll for an issue, and
 * a pane that has been visited kept alive so switching away is not the same as
 * throwing its state away.
 */
describe("ForgeIssueDetailSheet tabs", () => {
  function change(
    overrides: Partial<ForgeChangeDetail> = {}
  ): ForgeChangeDetail {
    return {
      number: 42,
      base_ref: "main",
      head_ref: "fix/timeout",
      head_repo: null,
      head_sha: "abc123",
      draft: false,
      state: "open",
      mergeable: true,
      merge_state: "clean",
      additions: 120,
      deletions: 8,
      changed_files: 3,
      commits: 2,
      checks: { checks: [], available: true, partial: false },
      ...overrides,
    }
  }

  /** An issue has no checks and no files, so its tab bar would be one tab wide
   *  and say nothing. It keeps the single scroll. */
  it("gives a change three panes and an issue none at all", async () => {
    forgeListComments.mockResolvedValue(commentPage([]))
    mount(row({ is_pr: false }))
    await screen.findByText("No comments yet")
    expect(screen.queryByRole("tab")).not.toBeInTheDocument()
    cleanup()

    forgeChangeDetail.mockResolvedValue(change())
    mount(row({ is_pr: true }))
    expect(
      await screen.findByRole("tab", { name: "Conversation" })
    ).toBeInTheDocument()
    expect(screen.getAllByRole("tab")).toHaveLength(3)
  })

  /** The pane that is not on show is out of the tree, not merely painted over
   *  — otherwise a screen reader reads all three at once. */
  it("shows one pane at a time", async () => {
    const user = userEvent.setup()
    forgeChangeDetail.mockResolvedValue(change())
    forgeListComments.mockResolvedValue(commentPage([]))
    mount(row({ is_pr: true }))
    await screen.findByText("No comments yet")
    expect(screen.getByPlaceholderText("Leave a comment…")).toBeVisible()

    await openTab(user, "Checks")
    expect(await screen.findByText("No checks ran")).toBeVisible()
    expect(screen.getByPlaceholderText("Leave a comment…")).not.toBeVisible()
  })

  /**
   * The thread pages, and a comment posted here does not exist on any page the
   * forge has served yet — a pane that remounted on every tab switch would
   * re-ask for page 1 and throw both away.
   */
  it("keeps a visited pane's state across a round trip through another tab", async () => {
    const user = userEvent.setup()
    forgeChangeDetail.mockResolvedValue(change())
    forgeListComments.mockResolvedValue(
      commentPage([comment({ body: "first" })])
    )
    forgeCreateComment.mockResolvedValue(
      comment({ id: "99", body: "and mine" })
    )
    mount(row({ is_pr: true }))
    await screen.findByText("first")

    await user.type(screen.getByPlaceholderText("Leave a comment…"), "and mine")
    await user.click(screen.getByRole("button", { name: "Comment" }))
    await screen.findByText("and mine")

    await openTab(user, "Checks")
    await openTab(user, "Conversation")

    expect(screen.getByText("and mine")).toBeInTheDocument()
    // One request for the thread, not two: the pane was never unmounted.
    expect(forgeListComments).toHaveBeenCalledTimes(1)
  })

  /**
   * The panel is non-modal — clicking another row swaps the item underneath
   * without ever closing. A reader who left the previous change on its Files
   * tab must not have this one's files fetched before they ask, and must never
   * see the previous change's branches under this one's title.
   */
  it("goes back to the discussion, and to nothing fetched, when the item swaps", async () => {
    const user = userEvent.setup()
    forgeChangeDetail.mockResolvedValue(change())
    forgeChangeFiles.mockResolvedValue(filePage([changedFile()]))
    const { view } = mount(row({ is_pr: true, number: 42 }))
    await openTab(user, "Files changed")
    await screen.findByText("src/a.rs")
    expect(forgeChangeFiles).toHaveBeenCalledTimes(1)

    forgeChangeDetail.mockResolvedValue(
      change({ number: 43, base_ref: "release/2", head_ref: "fix/other" })
    )
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ForgeIssueDetailSheet
          row={row({ is_pr: true, number: 43, title: "Another change" })}
          link={null}
          folderId={7}
          onOpenChange={vi.fn()}
          onStart={vi.fn()}
          onRowUpdated={vi.fn()}
          onCommentPosted={vi.fn()}
        />
      </NextIntlClientProvider>
    )

    // Never the outgoing item's branches under the incoming item's title.
    expect(screen.queryByText("main")).not.toBeInTheDocument()
    expect(await screen.findByText("release/2")).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Conversation" })).toHaveAttribute(
      "data-state",
      "active"
    )
    expect(forgeChangeFiles).toHaveBeenCalledTimes(1)
  })
})

/**
 * The three ways a posted comment used to go wrong, and the half-readable
 * check list — all four are races or orderings rather than plain rendering,
 * so each one is driven through the exact sequence that produced it.
 */
describe("ForgeIssueDetailSheet write races", () => {
  function change(
    overrides: Partial<ForgeChangeDetail> = {}
  ): ForgeChangeDetail {
    return {
      number: 42,
      base_ref: "main",
      head_ref: "fix/timeout",
      head_repo: null,
      head_sha: "abc123",
      draft: false,
      state: "open",
      mergeable: true,
      merge_state: "clean",
      additions: null,
      deletions: null,
      changed_files: null,
      commits: null,
      checks: { checks: [], available: true, partial: false },
      ...overrides,
    }
  }

  /** A posted comment is the NEWEST one. Appended into the paged collection it
   *  would sit at position 21 with pages 1–20 loaded, and the next "load more"
   *  would file comments 21–30 AFTER it — a thread reading 1…20, 31, 21…30. */
  it("keeps a posted comment last until its own page arrives", async () => {
    const user = userEvent.setup()
    forgeListComments.mockResolvedValueOnce(
      commentPage([comment({ id: "1", body: "oldest" })], true, 1)
    )
    forgeCreateComment.mockResolvedValue(
      comment({ id: "31", body: "just posted" })
    )
    mount(row())
    await screen.findByText("oldest")

    await user.type(
      screen.getByPlaceholderText("Leave a comment…"),
      "just posted"
    )
    await user.click(screen.getByRole("button", { name: "Comment" }))
    await screen.findByText("just posted")

    // Page 2 holds comments OLDER than the one just posted.
    forgeListComments.mockResolvedValueOnce(
      commentPage([comment({ id: "2", body: "middle" })], false, 2)
    )
    await user.click(screen.getByRole("button", { name: "Load more" }))
    await screen.findByText("middle")

    // Scoped to the thread: the item's own description goes through the same
    // renderer and would otherwise lead this list.
    const thread = screen.getByRole("list")
    const bodies = within(thread)
      .getAllByTestId("markdown")
      .map((el) => el.textContent)
    expect(bodies).toEqual(["oldest", "middle", "just posted"])
  })

  /** …and once the page it really lives on arrives, it is the same comment,
   *  not a second copy of it. */
  it("retires the posted copy when the forge serves the real one", async () => {
    const user = userEvent.setup()
    forgeListComments.mockResolvedValueOnce(commentPage([], true, 1))
    forgeCreateComment.mockResolvedValue(
      comment({ id: "31", body: "just posted" })
    )
    mount(row())
    await screen.findByPlaceholderText("Leave a comment…")

    await user.type(
      screen.getByPlaceholderText("Leave a comment…"),
      "just posted"
    )
    await user.click(screen.getByRole("button", { name: "Comment" }))
    await screen.findByText("just posted")

    forgeListComments.mockResolvedValueOnce(
      commentPage([comment({ id: "31", body: "just posted" })], false, 2)
    )
    await user.click(screen.getByRole("button", { name: "Load more" }))

    await waitFor(() =>
      expect(screen.getAllByText("just posted")).toHaveLength(1)
    )
  })

  /** A page-1 load still in flight REPLACES the collection wholesale. A
   *  comment posted while it was out must survive that — it exists on the
   *  forge, and a panel that dropped it would say a published comment is not
   *  there. */
  it("survives a refresh that lands after the post", async () => {
    const user = userEvent.setup()
    let releaseRefresh: (page: ForgeCommentList) => void = () => {}
    forgeListComments
      .mockResolvedValueOnce(commentPage([comment({ id: "1", body: "first" })]))
      .mockReturnValueOnce(
        new Promise<ForgeCommentList>((resolve) => {
          releaseRefresh = resolve
        })
      )
    forgeCreateComment.mockResolvedValue(
      comment({ id: "9", body: "posted mid-refresh" })
    )
    mount(row())
    await screen.findByText("first")

    // Refresh out, not yet back.
    await user.click(
      screen.getByRole("button", { name: "Refresh the comments" })
    )
    await user.type(
      screen.getByPlaceholderText("Leave a comment…"),
      "posted mid-refresh"
    )
    await user.click(screen.getByRole("button", { name: "Comment" }))
    await screen.findByText("posted mid-refresh")

    // The refresh lands now, without the new comment in it (the forge's own
    // page-1 was built before the post).
    releaseRefresh(commentPage([comment({ id: "1", body: "first" })]))

    await waitFor(() => expect(screen.getByText("first")).toBeInTheDocument())
    expect(screen.getByText("posted mid-refresh")).toBeInTheDocument()
  })

  /** The count is counted by the PAGE onto whatever it holds when this
   *  arrives — the sheet only says which item, because a row captured at
   *  submit time could be older than a close that resolved meanwhile. */
  it("reports the item rather than a row snapshot", async () => {
    const user = userEvent.setup()
    forgeListComments.mockResolvedValue(commentPage([]))
    forgeCreateComment.mockResolvedValue(comment({ id: "9", body: "ok" }))
    const { onCommentPosted } = mount(row({ is_pr: true, comments: 4 }))
    await screen.findByText("No comments yet")

    await user.type(screen.getByPlaceholderText("Leave a comment…"), "ok")
    await user.click(screen.getByRole("button", { name: "Comment" }))

    await waitFor(() => expect(onCommentPosted).toHaveBeenCalled())
    expect(onCommentPosted).toHaveBeenCalledWith({ isPr: true, number: 42 })
  })

  /** GitHub keeps check runs and commit statuses behind two DIFFERENT
   *  fine-grained permissions, so a token with only one of them gets a 403
   *  from one endpoint and an honest empty list from the other. Drawing that
   *  as "no checks ran" is green over red. */
  it("does not call a half-readable empty check list 'no checks ran'", async () => {
    const user = userEvent.setup()
    forgeChangeDetail.mockResolvedValue(
      change({ checks: { checks: [], available: true, partial: true } })
    )
    mount(row({ is_pr: true }))
    await openTab(user, "Checks")
    expect(
      await screen.findByText(
        "This account cannot read the repository's checks."
      )
    ).toBeInTheDocument()
    expect(screen.queryByText("No checks ran")).not.toBeInTheDocument()
  })

  /** With something readable, the half that arrived is shown — and said to be
   *  a half. */
  it("marks a partial check list beside the checks it did get", async () => {
    const user = userEvent.setup()
    forgeChangeDetail.mockResolvedValue(
      change({
        checks: {
          available: true,
          partial: true,
          checks: [
            {
              id: "1",
              name: "codecov",
              state: "success",
              summary: null,
              url: null,
              allow_failure: false,
            },
          ],
        },
      })
    )
    mount(row({ is_pr: true }))
    await openTab(user, "Checks")
    expect(await screen.findByText("codecov")).toBeInTheDocument()
    expect(screen.getByText("some could not be read")).toBeInTheDocument()
  })
})

/**
 * A file row opens onto what the change did to it. The diff costs no request —
 * both forges ship each file's hunks with the page itself — so the only
 * questions here are which rows can open and what comes out when they do.
 */
describe("ForgeIssueDetailSheet file diffs", () => {
  function change(): ForgeChangeDetail {
    return {
      number: 42,
      base_ref: "main",
      head_ref: "fix/timeout",
      head_repo: null,
      head_sha: "abc123",
      draft: false,
      state: "open",
      mergeable: true,
      merge_state: "clean",
      additions: 1,
      deletions: 1,
      changed_files: 1,
      commits: 1,
      checks: { checks: [], available: true, partial: false },
    }
  }

  beforeEach(() => {
    forgeChangeDetail.mockResolvedValue(change())
  })

  it("opens a file onto its own diff, and closes it again", async () => {
    const user = userEvent.setup()
    forgeChangeFiles.mockResolvedValue(
      filePage([
        changedFile({ patch: "@@ -1,2 +1,2 @@\n ctx\n-old line\n+new line\n" }),
      ])
    )
    mount(row({ is_pr: true }))
    await openTab(user, "Files changed")

    const trigger = await screen.findByRole("button", { name: /src\/a\.rs/ })
    // Collapsed until asked: the list answers "what does this touch" first.
    expect(trigger).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText("new line")).not.toBeInTheDocument()

    await user.click(trigger)
    expect(trigger).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("new line")).toBeInTheDocument()
    expect(screen.getByText("old line")).toBeInTheDocument()

    await user.click(trigger)
    expect(screen.queryByText("new line")).not.toBeInTheDocument()
  })

  /** Binary content has nothing textual to show, and a control that expands
   *  into an empty box is worse than no control. */
  it("offers no expander on a binary file", async () => {
    const user = userEvent.setup()
    forgeChangeFiles.mockResolvedValue(
      filePage([
        changedFile({
          path: "logo.png",
          status: "added",
          additions: null,
          deletions: null,
          binary: true,
          patch: null,
        }),
      ])
    )
    mount(row({ is_pr: true }))
    await openTab(user, "Files changed")

    expect(await screen.findByText("logo.png")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /logo\.png/ })
    ).not.toBeInTheDocument()
  })

  /**
   * Counted on both sides but no patch: a TEXT file whose diff GitHub withheld
   * for its size. That is not the same as binary, and a row that silently
   * refused to open would read as broken.
   */
  it("says so when the forge withheld a diff it did count", async () => {
    const user = userEvent.setup()
    forgeChangeFiles.mockResolvedValue(
      filePage([
        changedFile({
          path: "pnpm-lock.yaml",
          additions: 4000,
          deletions: 3000,
          binary: false,
          patch: null,
        }),
      ])
    )
    mount(row({ is_pr: true }))
    await openTab(user, "Files changed")

    expect(await screen.findByText("diff too large")).toBeInTheDocument()
    // Still counted — it is a text file, not a binary one.
    expect(screen.getByText("+4000")).toBeInTheDocument()
    expect(screen.queryByText("binary")).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /pnpm-lock/ })
    ).not.toBeInTheDocument()
  })

  /**
   * Two geometry rules an open diff has to keep, both invisible under jsdom —
   * asserted on the classes because that is where they live, and both regress
   * silently: nothing breaks, the panel just stops being usable.
   *
   * The cap, because one 900-line file otherwise pushes every path under it off
   * the panel and the list stops being a list. On the file's OWN section,
   * because a scrollbar is drawn on the edges of the element that scrolls: cap
   * a box around the diff instead and its horizontal bar stays at the bottom of
   * the file, hundreds of lines below the fold. Flush, because the row above is
   * the diff's own header — a gap there reads as a gap between two unrelated
   * things.
   */
  it("caps an open diff on its own scrollport, flush against its row", async () => {
    const user = userEvent.setup()
    forgeChangeFiles.mockResolvedValue(
      filePage([
        changedFile({ patch: "@@ -1,2 +1,2 @@\n ctx\n-old line\n+new line\n" }),
      ])
    )
    mount(row({ is_pr: true }))
    await openTab(user, "Files changed")
    await user.click(await screen.findByRole("button", { name: /src\/a\.rs/ }))

    const section = screen.getByText("new line").closest("section")
    expect(section?.className).toMatch(/max-h-\[/)

    const content = section?.closest('[data-slot="collapsible-content"]')
    expect(content).toHaveAttribute("data-state", "open")
    // Flush: nothing between the row's border and the diff.
    expect(content?.className).not.toMatch(/(^|\s)p[ytb]?-/)
    // And nothing in between capping or scrolling on its own — that is the
    // shape that strands the horizontal bar.
    for (
      let el = section?.parentElement;
      el != null && el !== content;
      el = el.parentElement
    ) {
      expect(el.className).not.toMatch(/max-h-|overflow-y-/)
    }
  })
})

/**
 * Landing a change from the panel.
 *
 * The box sits between the discussion and the composer — after everything said
 * about the change, before the place you would say the next thing — and it is
 * the one write here that cannot be undone from the panel afterwards. So what
 * matters is WHEN it is offered, when it is withheld, and that the method it
 * sends is the one on the button.
 */
describe("ForgeIssueDetailSheet merge box", () => {
  function change(
    overrides: Partial<ForgeChangeDetail> = {}
  ): ForgeChangeDetail {
    return {
      number: 42,
      base_ref: "main",
      head_ref: "fix/timeout",
      head_repo: null,
      head_sha: "abc123",
      draft: false,
      state: "open",
      mergeable: true,
      merge_state: "clean",
      additions: 1,
      deletions: 1,
      changed_files: 1,
      commits: 1,
      checks: { checks: [], available: true, partial: false },
      ...overrides,
    }
  }

  /** Both offered, a merge commit preselected — GitHub's usual answer. */
  function options(
    overrides: Partial<ForgeMergeOptions> = {}
  ): ForgeMergeOptions {
    return {
      methods: ["merge", "squash", "rebase"],
      default_method: "merge",
      merge_strategy: "merge_commit",
      ...overrides,
    }
  }

  const mergeButton = () =>
    screen.getByRole("button", { name: /^(Merge|Merging…)$/ })

  beforeEach(() => {
    forgeChangeDetail.mockResolvedValue(change())
    forgeMergeOptions.mockResolvedValue(options())
    forgeListComments.mockResolvedValue(commentPage([]))
  })

  it("offers the merge only on an open change", async () => {
    // An issue has no branches to join.
    mount(row({ is_pr: false }))
    await waitFor(() => expect(forgeListComments).toHaveBeenCalled())
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull()
    // And nothing is spent finding out what the repository permits.
    expect(forgeMergeOptions).not.toHaveBeenCalled()
    cleanup()

    // Already landed: there is nothing left to do, and neither forge would
    // accept the request anyway.
    forgeChangeDetail.mockResolvedValue(change({ state: "merged" }))
    mount(row({ is_pr: true, state: "merged" }))
    await waitFor(() => expect(forgeListComments).toHaveBeenCalled())
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull()
    expect(forgeMergeOptions).not.toHaveBeenCalled()
    cleanup()

    forgeChangeDetail.mockResolvedValue(change({ state: "closed" }))
    mount(row({ is_pr: true, state: "closed" }))
    await waitFor(() => expect(forgeListComments).toHaveBeenCalled())
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull()
    expect(forgeMergeOptions).not.toHaveBeenCalled()
    cleanup()

    forgeChangeDetail.mockResolvedValue(change())
    mount(row({ is_pr: true }))
    expect(await screen.findByRole("button", { name: "Merge" })).toBeEnabled()
    expect(forgeMergeOptions).toHaveBeenCalledWith(7)
  })

  /** The slot the user asked for, and the reason `CommentThread` grew one:
   *  under the discussion, over the box you would reply in. */
  it("sits between the last comment and the composer", async () => {
    forgeListComments.mockResolvedValue(
      commentPage([comment({ body: "Ship it" })])
    )
    mount(row({ is_pr: true }))

    const button = await screen.findByRole("button", { name: "Merge" })
    // Awaited rather than read straight off: the thread is virtualized, and it
    // stands the placeholder up until OverlayScrollbars has handed it the
    // scrollport to window against. The merge box needs no such thing, so it
    // can be on screen first — which says nothing about where it SITS.
    const lastComment = await screen.findByText("Ship it")
    const composer = screen.getByRole("textbox", { name: "Leave a comment…" })
    // `DOCUMENT_POSITION_FOLLOWING` — the node argument comes LATER in the
    // document than the one the method is called on.
    expect(
      lastComment.compareDocumentPosition(button) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      button.compareDocumentPosition(composer) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it("reads out the checks and the conflict verdict", async () => {
    forgeChangeDetail.mockResolvedValue(
      change({
        checks: {
          available: true,
          partial: false,
          checks: [
            {
              id: "1",
              name: "build",
              state: "success",
              summary: null,
              url: null,
              allow_failure: false,
            },
          ],
        },
      })
    )
    mount(row({ is_pr: true }))

    expect(
      await pane().findByText("All checks have passed")
    ).toBeInTheDocument()
    expect(pane().getByText("1 passing")).toBeInTheDocument()
    expect(
      pane().getByText("No conflicts with the base branch")
    ).toBeInTheDocument()
    cleanup()

    // Nothing ran, or the forge would not say: no headline at all, because a
    // line for "no answer" reads as a line for "fine".
    forgeChangeDetail.mockResolvedValue(
      change({ checks: { checks: [], available: false, partial: false } })
    )
    mount(row({ is_pr: true }))
    await screen.findByRole("button", { name: "Merge" })
    expect(pane().queryByText("All checks have passed")).toBeNull()
    expect(pane().queryByText("Some checks were not successful")).toBeNull()
  })

  /** "Not worked out yet" is not a refusal. Both forges answer it while a
   *  background job runs, and disabling the button over it would withhold a
   *  merge the forge would have accepted. */
  it("still offers the merge while mergeability is unknown", async () => {
    forgeChangeDetail.mockResolvedValue(
      change({ mergeable: null, merge_state: "unknown" })
    )
    mount(row({ is_pr: true }))
    expect(
      await pane().findByText("Checking whether it can be merged…")
    ).toBeInTheDocument()
    expect(mergeButton()).toBeEnabled()
  })

  it.each([
    [
      "a draft",
      { draft: true },
      // Set on BOTH: the freshly-read detail is what the box believes, and a
      // fixture where the two disagree would be testing the wrong thing.
      { draft: true },
      "This is a draft — mark it ready for review before merging.",
    ],
    [
      "a conflict",
      {},
      { mergeable: false, merge_state: "dirty" },
      "Resolve the conflicts with the base branch first.",
    ],
  ])(
    "withholds the merge on %s, and says why",
    async (_case, rowOverrides, detailOverrides, reason) => {
      forgeChangeDetail.mockResolvedValue(change(detailOverrides))
      mount(row({ is_pr: true, ...rowOverrides }))

      await screen.findByRole("button", { name: "Merge" })
      expect(mergeButton()).toBeDisabled()
      // The reason is on the strip beside it, not only in a tooltip: a
      // disabled button with no explanation reads as a broken one.
      expect(pane().getByText(reason)).toBeInTheDocument()
    }
  )

  /** The menu is the repository's answer, not this component's. A method the
   *  repository has turned off answers 405, so offering it would be offering a
   *  button that can only fail. */
  it("offers only the methods the repository permits", async () => {
    const user = userEvent.setup()
    forgeMergeOptions.mockResolvedValue(
      options({ methods: ["squash"], default_method: "squash" })
    )
    mount(row({ is_pr: true }))
    await screen.findByRole("button", { name: "Merge" })
    // One method left: there is nothing to choose, so there is no chooser.
    expect(
      screen.queryByRole("button", { name: "Choose a merge method" })
    ).toBeNull()
    cleanup()

    forgeMergeOptions.mockResolvedValue(options())
    mount(row({ is_pr: true }))
    await screen.findByRole("button", { name: "Merge" })
    await user.click(
      screen.getByRole("button", { name: "Choose a merge method" })
    )
    expect(
      await screen.findByRole("menuitem", { name: /Create a merge commit/ })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("menuitem", { name: /Squash and merge/ })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("menuitem", { name: /Rebase and merge/ })
    ).toBeInTheDocument()
  })

  it("merges with the method chosen from the menu, after asking", async () => {
    const user = userEvent.setup()
    const merged = row({ is_pr: true, state: "merged" })
    forgeMergeChange.mockResolvedValue(merged)
    const { onRowUpdated } = mount(row({ is_pr: true }))

    await screen.findByRole("button", { name: "Merge" })
    await user.click(
      screen.getByRole("button", { name: "Choose a merge method" })
    )
    await user.click(
      await screen.findByRole("menuitem", { name: /Squash and merge/ })
    )
    await user.click(mergeButton())

    // One click on somebody else's repository, with nothing typed first — the
    // same test the close button's confirmation was written for, and this one
    // cannot be undone from here.
    expect(await screen.findByText("Merge this change?")).toBeInTheDocument()
    expect(forgeMergeChange).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Squash and merge" }))

    await waitFor(() =>
      expect(forgeMergeChange).toHaveBeenCalledWith(
        7,
        {
          number: 42,
          method: "squash",
          // The commit the panel DECIDED on — its diff, its files and its checks
          // all describe this one. Both forges refuse with a 409 if the branch
          // has moved, which is the point of sending it.
          headSha: "abc123",
        },
        null
      )
    )
    // The FORGE's row, not a local flip: GitHub has no merged state, and only
    // its answer knows this one landed rather than closed.
    await waitFor(() =>
      expect(onRowUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ state: "merged" })
      )
    )
    expect(toastSuccess).toHaveBeenCalledWith("Merged")
    // The detail's own copy of the state is now stale — `MergeReadiness` reads
    // it, and would go on offering "Can be merged" for a change that landed.
    await waitFor(() => expect(forgeChangeDetail).toHaveBeenCalledTimes(2))
  })

  /**
   * The forge's own sentence is the whole value of the failure: "not
   * mergeable" and "merge commits are not allowed here" send a reader to two
   * completely different places.
   *
   * And the dialog goes away. The likeliest refusal is "Head branch was
   * modified. Review and try the merge again." — leaving a one-click retry
   * open over a panel that is re-reading into a DIFFERENT commit is how an
   * unreviewed head gets merged.
   */
  it("dismisses the confirmation and re-reads when the forge refuses", async () => {
    const user = userEvent.setup()
    forgeMergeChange.mockRejectedValue(
      new Error("Head branch was modified. Review and try the merge again.")
    )
    const { onRowUpdated } = mount(row({ is_pr: true }))

    await screen.findByRole("button", { name: "Merge" })
    await user.click(mergeButton())
    await user.click(
      await screen.findByRole("button", { name: "Create a merge commit" })
    )

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(onRowUpdated).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(screen.queryByText("Merge this change?")).toBeNull()
    )
    // Back to the change as it is NOW, not the one that was just refused.
    await waitFor(() => expect(forgeChangeDetail).toHaveBeenCalledTimes(2))
  })

  /** The dialog asks about ONE commit — the one whose diff, files and checks
   *  are on screen behind it. A refresh underneath it must not be able to swap
   *  that commit out from under the answer. */
  it("merges the head the confirmation was armed with, not a newer one", async () => {
    const user = userEvent.setup()
    forgeChangeDetail.mockResolvedValue(change({ head_sha: "reviewed1" }))
    forgeMergeChange.mockResolvedValue(row({ is_pr: true, state: "merged" }))
    mount(row({ is_pr: true }))

    await screen.findByRole("button", { name: "Merge" })
    await user.click(mergeButton())
    await screen.findByText("Merge this change?")

    // Somebody pushes, and the panel re-reads while the dialog is open.
    forgeChangeDetail.mockResolvedValue(change({ head_sha: "pushed2" }))
    await user.click(
      screen.getByRole("button", { name: "Create a merge commit" })
    )

    await waitFor(() =>
      expect(forgeMergeChange).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ headSha: "reviewed1" }),
        null
      )
    )
  })
})

/**
 * The four ways this box could have told somebody something untrue. Each of
 * these was a real defect: a green headline over a half-read check list, a
 * "create a merge commit" on a project that fast-forwards, a merge offered on
 * a change the forge already merged, and a completed merge reported as failed.
 */
describe("ForgeIssueDetailSheet merge box honesty", () => {
  function change(
    overrides: Partial<ForgeChangeDetail> = {}
  ): ForgeChangeDetail {
    return {
      number: 42,
      base_ref: "main",
      head_ref: "fix/timeout",
      head_repo: null,
      head_sha: "abc123",
      draft: false,
      state: "open",
      mergeable: true,
      merge_state: "clean",
      additions: 1,
      deletions: 1,
      changed_files: 1,
      commits: 1,
      checks: { checks: [], available: true, partial: false },
      ...overrides,
    }
  }

  function check(id: string, state: ForgeCheck["state"]): ForgeCheck {
    return {
      id,
      name: `check-${id}`,
      state,
      summary: null,
      url: null,
      allow_failure: false,
    }
  }

  beforeEach(() => {
    forgeChangeDetail.mockResolvedValue(change())
    forgeMergeOptions.mockResolvedValue({
      methods: ["merge", "squash"],
      default_method: "merge",
      merge_strategy: "merge_commit",
    })
    forgeListComments.mockResolvedValue(commentPage([]))
  })

  /** GitHub keeps its checks in two collections behind two permissions, so a
   *  token holding one of them reads a green list over a red build. `partial`
   *  is the backend saying so; "All checks have passed" would bury it. */
  it("does not claim every check passed when the list is incomplete", async () => {
    forgeChangeDetail.mockResolvedValue(
      change({
        checks: {
          available: true,
          partial: true,
          checks: [check("1", "success")],
        },
      })
    )
    mount(row({ is_pr: true }))

    expect(
      await pane().findByText("Not every check reported a result")
    ).toBeInTheDocument()
    expect(pane().queryByText("All checks have passed")).toBeNull()
    // The count was never the overclaim — one check really did pass.
    expect(pane().getByText("1 passing")).toBeInTheDocument()
    cleanup()

    // A skipped check is not a pass either — this codebase's own rule for
    // `neutral`, which `tallyChecks` counts into none of the three tallies.
    forgeChangeDetail.mockResolvedValue(
      change({
        checks: {
          available: true,
          partial: false,
          checks: [check("1", "success"), check("2", "neutral")],
        },
      })
    )
    mount(row({ is_pr: true }))
    expect(
      await pane().findByText("Not every check reported a result")
    ).toBeInTheDocument()
    cleanup()

    // Nothing missing, nothing skipped: the strong headline is earned.
    forgeChangeDetail.mockResolvedValue(
      change({
        checks: {
          available: true,
          partial: false,
          checks: [check("1", "success"), check("2", "success")],
        },
      })
    )
    mount(row({ is_pr: true }))
    expect(
      await pane().findByText("All checks have passed")
    ).toBeInTheDocument()
  })

  /** GitLab's merge endpoint takes no method — the PROJECT decides between a
   *  merge commit, a rebase-merge and a fast-forward. Labelling a
   *  fast-forward-only project "Create a merge commit" promises a commit its
   *  history will never contain. */
  it("names what the project will actually do, not what the verb suggests", async () => {
    const user = userEvent.setup()
    forgeMergeOptions.mockResolvedValue({
      methods: ["merge", "squash"],
      default_method: "merge",
      merge_strategy: "fast_forward",
    })
    mount(row({ is_pr: true }))
    await screen.findByRole("button", { name: "Merge" })
    await user.click(
      screen.getByRole("button", { name: "Choose a merge method" })
    )

    expect(
      await screen.findByRole("menuitem", { name: /Fast-forward merge/ })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("menuitem", { name: /Create a merge commit/ })
    ).toBeNull()
    cleanup()

    // And GitLab's `rebase_merge` is NOT GitHub's "Rebase and merge": it
    // rebases and then still writes a merge commit. Borrowing that wording
    // would promise a linear history the project never produces.
    forgeMergeOptions.mockResolvedValue({
      methods: ["merge", "squash"],
      default_method: "merge",
      merge_strategy: "rebase_merge",
    })
    mount(row({ is_pr: true }))
    await screen.findByRole("button", { name: "Merge" })
    await user.click(
      screen.getByRole("button", { name: "Choose a merge method" })
    )
    expect(
      await screen.findByRole("menuitem", {
        name: /Merge commit with semi-linear history/,
      })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("menuitem", { name: /^Rebase and merge/ })
    ).toBeNull()
  })

  /** The mirror image of the stale-row case, and the reason neither copy is
   *  the authority: `useChangeDetail` KEEPS its last answer across a failed
   *  reload, so right after a merge whose re-read failed it is the detail that
   *  still says `open` — over a row the merge itself just made authoritative. */
  it("withdraws the merge when the row says merged and only the stale detail disagrees", async () => {
    forgeChangeDetail.mockResolvedValue(change({ state: "open" }))
    mount(row({ is_pr: true, state: "merged" }))

    await waitFor(() => expect(forgeChangeDetail).toHaveBeenCalled())
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull()
  })

  /** The row comes from GitHub's search index, which the panel's own comments
   *  say lags a write by seconds. The detail was read directly — so when the
   *  two disagree about whether this already landed, the detail wins. */
  it("withdraws the merge when the fresh detail says it already landed", async () => {
    forgeChangeDetail.mockResolvedValue(change({ state: "merged" }))
    // The list still believes it is open.
    mount(row({ is_pr: true, state: "open" }))

    await waitFor(() => expect(forgeChangeDetail).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Merge" })).toBeNull()
    )
    cleanup()

    // Same rule for the draft flag, which the list can also be behind on.
    forgeChangeDetail.mockResolvedValue(change({ draft: true }))
    mount(row({ is_pr: true, draft: false }))
    await screen.findByRole("button", { name: "Merge" })
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^(Merge|Merging…)$/ })
      ).toBeDisabled()
    )
  })

  /** GitHub's merge response does not contain the pull request, so the row
   *  costs a second request that can fail on its own. The merge is already
   *  irreversible by then — calling it a failure would invite a second one. */
  it("treats a merge whose row could not be re-read as merged", async () => {
    const user = userEvent.setup()
    forgeMergeChange.mockResolvedValue(null)
    const { onRowUpdated } = mount(row({ is_pr: true }))

    await screen.findByRole("button", { name: "Merge" })
    await user.click(screen.getByRole("button", { name: /^(Merge|Merging…)$/ }))
    await user.click(
      await screen.findByRole("button", { name: "Create a merge commit" })
    )

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Merged"))
    expect(toastError).not.toHaveBeenCalled()
    // The one place a local state flip is sound: the merge itself succeeded.
    expect(onRowUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ state: "merged", number: 42 })
    )
  })
})

/**
 * One left edge down the whole conversation.
 *
 * The description, every comment, the merge box and the composer each sit
 * beside a 24px gutter; before this they were four different left edges and
 * the text column stepped in and out on the way down the tab. The assertions
 * are about the GUTTER's occupants rather than about class names: an avatar
 * that stopped rendering is what a reader would notice, and it is what these
 * catch.
 */
describe("ForgeIssueDetailSheet conversation rail", () => {
  beforeEach(() => {
    forgeListComments.mockResolvedValue(commentPage([]))
  })

  /** Free: both forges ship the author's picture with the list row, so the
   *  description's avatar costs no request of its own. */
  it("shows the item's author beside the description", async () => {
    mount(row({ author: "octocat" }))
    const avatar = await screen.findByRole("img", { name: "octocat" })
    const body = screen.getByTestId("markdown")
    expect(
      avatar.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  /**
   * The gutter pins, so a thousand-word comment still says who is writing it
   * at the bottom.
   *
   * Two halves, and both fail silently. The circle has to be `sticky` inside a
   * column that has no height of its own — one that stretches to the rail, so
   * there is something to travel in; `sticky` on a box already filling its
   * containing block never moves. And nothing between it and the pane may
   * clip: a single `overflow-hidden` added to a wrapper for a rounded corner
   * turns the pinning off with no other symptom at all. Neither is observable
   * under jsdom, which is exactly why they are worth pinning here.
   */
  it("pins the gutter while the block beside it scrolls past", async () => {
    mount(row({ author: "octocat" }))
    const avatar = await screen.findByRole("img", { name: "octocat" })
    expect(avatar.className).toMatch(/(^|\s)sticky(\s|$)/)

    // The column it travels in: sized by the rail, not by itself.
    const column = avatar.parentElement
    expect(column?.className).not.toMatch(/(^|\s)(h-|size-|max-h-)/)

    // A clear run from there out to the pane's scrollport. `overflow-hidden`
    // on the comment card beside it is fine and deliberate — this is about
    // ANCESTORS.
    const pane = avatar.closest("[data-overlayscrollbars-initialize]")
    expect(pane).not.toBeNull()
    for (let el = column; el != null && el !== pane; el = el.parentElement) {
      expect(el.className).not.toMatch(/(^|\s)overflow-/)
    }
  })

  /** A deleted account leaves a gutter, not a hole — the column has to keep
   *  its left edge whether or not the forge remembers who wrote the thing. */
  it("keeps the gutter when there is no author to put in it", async () => {
    mount(row({ author: null, author_avatar: null }))
    await waitFor(() => expect(forgeListComments).toHaveBeenCalled())
    expect(screen.queryByRole("img", { name: "octocat" })).toBeNull()
    // Two of them: the author nobody knows, and the account still being
    // resolved for the composer at the bottom of the same column.
    expect(screen.getAllByText("?")).toHaveLength(2)
  })

  /** Which account a comment is posted as is the BACKEND's decision — from the
   *  remote's host and whatever is pinned to it — so the panel says whose it
   *  will be rather than leaving it to be discovered afterwards. */
  it("names the account the comment would be posted as", async () => {
    forgeIdentity.mockResolvedValue({
      username: "hubot",
      avatar_url: "https://avatars.test/u/9",
    })
    mount(row())

    const avatar = await screen.findByRole("img", {
      name: "Commenting as hubot",
    })
    const composer = screen.getByRole("textbox", { name: "Leave a comment…" })
    expect(
      avatar.compareDocumentPosition(composer) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(forgeIdentity).toHaveBeenCalledWith(7)
  })

  /** The lookup is a nicety. Losing it must cost the NAME and nothing else —
   *  a composer that stopped accepting comments because it could not draw a
   *  face would be a far worse trade. */
  it("still composes when the account cannot be resolved", async () => {
    const user = userEvent.setup()
    forgeIdentity.mockRejectedValue(new Error("no account for this host"))
    forgeCreateComment.mockResolvedValue(comment({ id: "9", body: "ok" }))
    mount(row())

    await waitFor(() => expect(forgeIdentity).toHaveBeenCalled())
    expect(screen.queryByRole("img", { name: /Commenting as/ })).toBeNull()

    await user.type(
      screen.getByRole("textbox", { name: "Leave a comment…" }),
      "ok"
    )
    await user.click(screen.getByRole("button", { name: "Comment" }))
    await waitFor(() => expect(forgeCreateComment).toHaveBeenCalled())
  })

  /** Per FOLDER, not per item: the thread below is keyed by the item and
   *  remounts as the reader clicks through the list, and re-asking on each of
   *  them would be a lookup per row read. */
  it("resolves the account once for the folder, not once per item", async () => {
    forgeIdentity.mockResolvedValue({ username: "hubot", avatar_url: null })
    const { view } = mount(row({ number: 42 }))
    await waitFor(() => expect(forgeIdentity).toHaveBeenCalledTimes(1))

    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ForgeIssueDetailSheet
          row={row({ number: 43, title: "Another one" })}
          link={null}
          folderId={7}
          onOpenChange={vi.fn()}
          onStart={vi.fn()}
          onRowUpdated={vi.fn()}
          onCommentPosted={vi.fn()}
        />
      </NextIntlClientProvider>
    )
    await screen.findByText("Another one")
    expect(forgeIdentity).toHaveBeenCalledTimes(1)
  })

  /** The drawer is mounted for the whole of the reader's time on the page,
   *  with a `null` row while it is closed. Resolving an account for a composer
   *  nobody has looked at is a keyring read spent on nothing. */
  it("does not go looking for an account until the panel is open", async () => {
    mount(null)
    await waitFor(() => expect(forgeListComments).not.toHaveBeenCalled())
    expect(forgeIdentity).not.toHaveBeenCalled()
  })

  /**
   * A lookup left over from the repository the reader has since left must not
   * name the account on the next panel they open.
   *
   * The keyed reset cannot catch this one: it keys on the FOLDER, and by the
   * time the late answer lands the folder has already finished changing. So
   * the in-flight request has to be invalidated on the way past — including by
   * the renders that ask for nothing, which is every render while the panel is
   * shut, and which is exactly the window this race lives in.
   */
  it("ignores an account resolved for the repository that was left", async () => {
    // Both lookups stay in the test's hands. The window that matters is the
    // one where the panel has reopened and its OWN answer has not arrived: a
    // lookup that resolved would paper over the stale one a moment later, and
    // an assertion made after that would pass either way.
    const settle = new Map<number, (value: ForgeIdentity) => void>()
    forgeIdentity.mockImplementation(
      (folderId: number) =>
        new Promise<ForgeIdentity>((resolve) => {
          settle.set(folderId, resolve)
        })
    )

    const panel = (item: ForgeIssueRow | null, folderId: number) => (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ForgeIssueDetailSheet
          row={item}
          link={null}
          folderId={folderId}
          onOpenChange={vi.fn()}
          onStart={vi.fn()}
          onRowUpdated={vi.fn()}
          onCommentPosted={vi.fn()}
        />
      </NextIntlClientProvider>
    )

    // Open on folder 7, with its lookup still out.
    const { view } = mount(row(), null, { folderId: 7 })
    await waitFor(() => expect(forgeIdentity).toHaveBeenCalledWith(7))

    // Close it, then move to folder 8 while it is shut.
    view.rerender(panel(null, 7))
    view.rerender(panel(null, 8))

    // Folder 7 finally answers, into a panel that is now somewhere else. The
    // flush is load-bearing: without it the continuation would still be queued
    // when the panel reopens below, and the reopen's own request would claim
    // the counter first — the race would be won by accident rather than by the
    // guard, and this test would pass with the guard removed.
    settle.get(7)?.({ username: "on-a", avatar_url: null })
    await act(async () => {})

    // Reopen on 8, and let 8's lookup go out but not come back.
    view.rerender(panel(row(), 8))
    await waitFor(() => expect(forgeIdentity).toHaveBeenCalledWith(8))

    // THE window: an anonymous gutter is the only honest thing to draw here.
    expect(screen.queryByRole("img", { name: /Commenting as/ })).toBeNull()

    // And 8's own answer still lands when it comes.
    settle.get(8)?.({ username: "on-b", avatar_url: null })
    await waitFor(() =>
      expect(
        screen.getByRole("img", { name: "Commenting as on-b" })
      ).toBeInTheDocument()
    )
  })

  /** The merge box is not a person, but it is in the same column — the glyph
   *  is what keeps the box's left edge on the rail rather than 34px left of
   *  everything above it. */
  it("puts the merge box in the gutter too", async () => {
    forgeChangeDetail.mockResolvedValue({
      number: 42,
      base_ref: "main",
      head_ref: "fix/timeout",
      head_repo: null,
      head_sha: "abc123",
      draft: false,
      state: "open",
      mergeable: true,
      merge_state: "clean",
      additions: 1,
      deletions: 1,
      changed_files: 1,
      commits: 1,
      checks: { checks: [], available: true, partial: false },
    })
    forgeMergeOptions.mockResolvedValue({
      methods: ["merge"],
      default_method: "merge",
      merge_strategy: "merge_commit",
    })
    mount(row({ is_pr: true }))

    const button = await screen.findByRole("button", { name: "Merge" })
    // The box's own card, and the gutter column that has to be its previous
    // sibling for the two to share the rail with the comments above.
    const card = button.closest("div.rounded-xl")
    expect(card).not.toBeNull()
    const column = card?.previousElementSibling
    expect(column?.firstElementChild).toHaveClass("rounded-full")
  })

  /**
   * The repository is part of what the panel's own lookups are ABOUT, so a
   * switch of it has to blank them, not just re-ask.
   *
   * `forgeIdentity` is asked for by FOLDER and answered about whatever remote
   * that folder names — and the real backend reads the same folder, so the
   * answer for the folder really does change under a switch. Keyed on the folder
   * alone the panel went on naming the previous repository's account until its
   * own request came back, over a row that had already been re-read from the new
   * one. The window is the whole point: both requests are held open here, since
   * an answer that resolved would paper over the stale one a moment later.
   */
  it("names no account from the repository the switch left, not even for a frame", async () => {
    const settle = new Map<number, (value: ForgeIdentity) => void>()
    forgeIdentity.mockImplementation(
      (folderId: number) =>
        new Promise<ForgeIdentity>((resolve) => {
          settle.set(folderId, resolve)
        })
    )

    const { view } = mount(row(), null, {
      folderId: 7,
      repo: "github.com/me/codeg",
    })
    await waitFor(() => expect(forgeIdentity).toHaveBeenCalledWith(7))
    settle.get(7)?.({ username: "on-the-fork", avatar_url: null })
    await waitFor(() =>
      expect(
        screen.getByRole("img", { name: "Commenting as on-the-fork" })
      ).toBeInTheDocument()
    )

    // Same folder, other repository — the picker in action.
    view.rerender(panelWithRepo(row(), 7, "github.com/acme/codeg-parent"))

    // The new repository's lookup has gone out and has not answered, and the
    // fork's account must not be standing in for it.
    await waitFor(() => expect(forgeIdentity).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole("img", { name: /Commenting as/ })).toBeNull()

    settle.get(7)?.({ username: "on-the-parent", avatar_url: null })
    await waitFor(() =>
      expect(
        screen.getByRole("img", { name: "Commenting as on-the-parent" })
      ).toBeInTheDocument()
    )
  })

  /** The same rule for the merge box: which methods the forge permits is a fact
   *  about the repository, and the box must not go on offering the fork's while
   *  the parent's is on screen. Held open, as the account lookup is — the claim
   *  is about the window before the new answer lands. */
  it("withholds the merge on a repository switch until the new one answers", async () => {
    forgeChangeDetail.mockResolvedValue({
      number: 42,
      base_ref: "main",
      head_ref: "fix/timeout",
      head_repo: null,
      head_sha: "abc123",
      draft: false,
      state: "open",
      mergeable: true,
      merge_state: "clean",
      additions: 1,
      deletions: 1,
      changed_files: 1,
      commits: 1,
      checks: { checks: [], available: true, partial: false },
    })
    // Held in a list rather than a `let … | null`: the resolve is stored from
    // inside the mock, and TypeScript's control-flow analysis cannot see an
    // assignment made in a callback, so it narrows a `let` back to `null` at
    // the call site and refuses the call outright.
    const settles: Array<(value: ForgeMergeOptions) => void> = []
    forgeMergeOptions
      .mockResolvedValueOnce({
        methods: ["squash"],
        default_method: "squash",
        merge_strategy: "squash",
      })
      .mockImplementationOnce(
        () =>
          new Promise<ForgeMergeOptions>((resolve) => {
            settles.push(resolve)
          })
      )

    const mergeButton = () =>
      screen.getByRole("button", { name: /^(Merge|Merging…)$/ })
    const { view } = mount(row({ is_pr: true }), null, {
      folderId: 7,
      repo: "github.com/me/codeg",
    })
    await waitFor(() => expect(mergeButton()).toBeEnabled())

    view.rerender(
      panelWithRepo(row({ is_pr: true }), 7, "github.com/acme/codeg-parent")
    )

    // Blanked rather than carried over: the method the fork prefers is a claim
    // about a repository this panel is no longer reading, and the box says so
    // by not being willing to merge until the new repository has answered.
    await waitFor(() => expect(forgeMergeOptions).toHaveBeenCalledTimes(2))
    expect(mergeButton()).toBeDisabled()

    // And the parent's own answer still lands when it comes.
    settles[0]?.({
      methods: ["merge"],
      default_method: "merge",
      merge_strategy: "merge_commit",
    })
    await waitFor(() => expect(mergeButton()).toBeEnabled())
  })
})

/**
 * The unified/side-by-side switch, above the list rather than inside it.
 *
 * It used to render once per EXPANDED file, halfway down the panel and only
 * after something had been opened — while the button it belongs beside (the
 * reload) was in the header the whole time.
 */
describe("ForgeIssueDetailSheet file view toggle", () => {
  const toggle = () => screen.queryByRole("button", { name: /Switch to/ })

  beforeEach(() => {
    forgeChangeDetail.mockResolvedValue({
      number: 42,
      base_ref: "main",
      head_ref: "fix/timeout",
      head_repo: null,
      head_sha: "abc123",
      draft: false,
      state: "open",
      mergeable: true,
      merge_state: "clean",
      additions: 1,
      deletions: 1,
      changed_files: 1,
      commits: 1,
      checks: { checks: [], available: true, partial: false },
    })
    forgeMergeOptions.mockResolvedValue({
      methods: ["merge"],
      default_method: "merge",
      merge_strategy: "merge_commit",
    })
  })

  it("offers the switch beside the reload, and an expanded file carries none", async () => {
    const user = userEvent.setup()
    forgeChangeFiles.mockResolvedValue(
      filePage([
        changedFile({ patch: "@@ -1,2 +1,2 @@\n ctx\n-old line\n+new line\n" }),
      ])
    )
    mount(row({ is_pr: true }))
    await openTab(user, "Files changed")

    const control = await screen.findByRole("button", { name: /Switch to/ })
    const reload = screen.getByRole("button", { name: "Refresh the file list" })
    expect(
      control.compareDocumentPosition(reload) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    // Above the list, so it is there before anything is opened — and opening a
    // file must not add a second one.
    await user.click(screen.getByRole("button", { name: /src\/a\.rs/ }))
    expect(screen.getByText("new line")).toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: /Switch to/ })).toHaveLength(1)
  })

  /** A new file has no "before" side and renders identically either way, and a
   *  diff the forge withheld cannot be opened at all — a switch over either is
   *  a control that visibly does nothing. */
  it("says nothing when no listed file has two sides to show", async () => {
    const user = userEvent.setup()
    forgeChangeFiles.mockResolvedValue(
      filePage([
        changedFile({ path: "src/new.rs", status: "added" }),
        changedFile({ path: "src/huge.rs", patch: null }),
      ])
    )
    mount(row({ is_pr: true }))
    await openTab(user, "Files changed")

    await screen.findByText("src/new.rs")
    expect(toggle()).toBeNull()
    expect(
      screen.getByRole("button", { name: "Refresh the file list" })
    ).toBeInTheDocument()
  })
})
