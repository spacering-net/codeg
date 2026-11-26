import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import {
  Children,
  forwardRef,
  useImperativeHandle,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { MessageNavScrollContext } from "@/components/message/message-nav-scroll-context"
import {
  SessionViewerHostContext,
  type SessionViewerRequest,
} from "@/components/message/session-viewer-host-context"
import type {
  DelegationCardModel,
  DelegationCardSource,
} from "@/hooks/use-delegation-card-model"
import {
  MessageNavList,
  type MessageNavEntry,
} from "./conversation-message-nav"

const { openFileTarget, models } = vi.hoisted(() => ({
  openFileTarget: vi.fn(async () => {}),
  models: new Map<string, Partial<DelegationCardModel>>(),
}))

vi.mock("@/hooks/use-open-file-target", () => ({
  useOpenFileTarget: () => openFileTarget,
}))
vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolder: { path: "/repo" } }),
}))
// What a sub-agent card shows comes from the model the transcript's delegation
// card resolves too; here it is just set per call id.
vi.mock("@/hooks/use-delegation-card-model", () => ({
  useDelegationCardModel: (source: DelegationCardSource) => ({
    agentType: "codex",
    identity: { agentType: "codex", assistantId: null, assistantName: null },
    task: null,
    taskId: null,
    status: "ok",
    errorCode: undefined,
    childConversationId: null,
    childConnectionId: null,
    hasModel: true,
    ...models.get(source.parentToolUseId),
  }),
}))
// jsdom lays nothing out: the virtualizer renders every row, each 33px tall
// as far as the list can tell.
vi.mock("virtua", () => ({
  Virtualizer: forwardRef(function VirtualizerMock(
    props: {
      children?: ReactNode | ((item: unknown, index: number) => ReactElement)
      data?: readonly unknown[]
      as?: string
      item?: string
    },
    ref: Ref<unknown>
  ) {
    useImperativeHandle(ref, () => ({
      getItemOffset: (index: number) => index * 33,
      getItemSize: () => 33,
    }))
    const List = (props.as ?? "div") as "ol"
    const Item = (props.item ?? "div") as "li"
    const { children, data } = props
    // Every row, in view or not; what virtua would render lazily.
    const rows =
      typeof children === "function"
        ? (data ?? []).map((item, index) => children(item, index))
        : Children.toArray(children)
    return (
      <List data-testid="virtual-list">
        {rows.map((row, index) => (
          <Item key={index}>{row}</Item>
        ))}
      </List>
    )
  }),
}))

const ADDED_DIFF =
  "--- /dev/null\n+++ b/src/a.ts\n@@ -0,0 +1,2 @@\n+export const a = 1\n+export const b = 2"
const EDIT_DIFF =
  "--- a/src/b.ts\n+++ b/src/b.ts\n@@ -3,2 +3,2 @@\n context\n-old line\n+new line"
const DELETION_DIFF = "*** Delete File: old.ts\n-a\n-b\n-c\n-d"

function source(id: string, over: Partial<DelegationCardSource> = {}) {
  return { parentToolUseId: id, input: null, ...over }
}

const entries: MessageNavEntry[] = [
  {
    threadIndex: 0,
    turnIndex: null,
    turnId: "u1",
    ordinal: 1,
    label: "first message",
    additions: 0,
    deletions: 0,
    files: [],
    subAgents: [],
    hasChanges: false,
  },
  {
    // One-sided change: additions only.
    threadIndex: 3,
    turnIndex: null,
    turnId: "u2",
    ordinal: 2,
    label: "edit something",
    additions: 5,
    deletions: 0,
    files: [
      {
        id: "f1",
        path: "/repo/src/a.ts",
        additions: 2,
        deletions: 0,
        diff: ADDED_DIFF,
      },
      {
        id: "f2",
        path: "/repo/src/b.ts",
        additions: 3,
        deletions: 0,
        diff: EDIT_DIFF,
      },
    ],
    subAgents: [source("tu-1")],
    hasChanges: true,
  },
  {
    threadIndex: 6,
    turnIndex: null,
    turnId: "u3",
    ordinal: 3,
    label: "delete a file",
    additions: 0,
    deletions: 4,
    files: [
      {
        id: "f3",
        path: "/repo/old.ts",
        additions: 0,
        deletions: 4,
        diff: DELETION_DIFF,
      },
    ],
    subAgents: [],
    hasChanges: true,
  },
]

/** A message above the loaded window: listed, but not rendered yet. */
const earlierEntry: MessageNavEntry = {
  threadIndex: null,
  turnIndex: 12,
  turnId: "turn-12",
  ordinal: 1,
  label: "an early message",
  additions: 0,
  deletions: 0,
  files: [],
  subAgents: [],
  hasChanges: false,
}

const opened: SessionViewerRequest[] = []

function renderList(
  props: Partial<Parameters<typeof MessageNavList>[0]> = {},
  {
    host = true,
    scrollElement = null,
  }: { host?: boolean; scrollElement?: HTMLElement | null } = {}
) {
  const list: ReactNode = (
    <MessageNavList entries={entries} onSelect={vi.fn()} {...props} />
  )
  const tree: ReactNode = (
    <MessageNavScrollContext.Provider value={scrollElement}>
      {list}
    </MessageNavScrollContext.Provider>
  )
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {host ? (
        <SessionViewerHostContext.Provider
          value={{ open: (request) => opened.push(request) }}
        >
          {tree}
        </SessionViewerHostContext.Provider>
      ) : (
        tree
      )}
    </NextIntlClientProvider>
  )
}

/** The button of the message labelled `label`: it jumps to the message. */
function messageButton(label: string): HTMLElement {
  return screen.getByText(label).closest("button") as HTMLElement
}

/** The chevron at the end of `label`'s row that opens or closes it, if it
 *  has one. */
function toggleOf(label: string): HTMLElement | null {
  return messageButton(label).parentElement!.querySelector(
    "[data-testid='nav-message-toggle']"
  )
}

/** The file box of `name`. */
function fileBox(name: string): HTMLElement {
  // The file's line names it; an open diff's title bar does too.
  const line = screen
    .getAllByText(name)
    .map((el) => el.closest("[data-testid=nav-file]"))
    .find((el) => el != null)!
  return line.parentElement as HTMLElement
}

beforeEach(() => {
  vi.clearAllMocks()
  models.clear()
  opened.length = 0
  localStorage.clear()
})

describe("MessageNavList", () => {
  describe("while the agent answers a message", () => {
    const running = { turnId: "u3", startedAt: Date.now() - 65_000 }

    it("lists that message first, its clock running", () => {
      renderList({ running })
      const pinned = screen.getByTestId("nav-running")
      expect(pinned).toHaveTextContent("delete a file")
      expect(within(pinned).getByTestId("nav-running-clock")).toHaveTextContent(
        /1m [56]s/
      )
      // First in the list, and listed once.
      const labels = screen
        .getAllByTestId("nav-message")
        .map((row) => row.textContent)
      expect(labels[0]).toContain("delete a file")
      expect(
        labels.filter((label) => label?.includes("delete a file"))
      ).toHaveLength(1)
      expect(labels.slice(1).map((l) => l?.replace(/\d+$/, ""))).toEqual([
        expect.stringContaining("first message"),
        expect.stringContaining("edit something"),
      ])
    })

    // Open (it is the latest), its round ends in a hairline of its own:
    // the place it is pinned to adds one only while it is closed.
    it("sets it apart from the rest by one hairline", () => {
      renderList({ running })
      const pinned = screen.getByTestId("nav-running")
      expect(toggleOf("delete a file")).toHaveAttribute("aria-expanded", "true")
      expect(pinned).not.toHaveClass("border-b")
      // The one there is: the round's, under the head.
      const round = pinned.querySelector(".pb-px")!.lastElementChild
      expect(round).toHaveClass("border-b")
      expect(pinned.querySelectorAll(".border-b")).toHaveLength(1)
      fireEvent.click(toggleOf("delete a file")!)
      // Closed, the place's own hairline is the only one.
      const closed = screen.getByTestId("nav-running")
      expect(closed).toHaveClass("border-b")
      expect(closed.querySelectorAll(".border-b")).toHaveLength(0)
    })

    it("says it is running in words for a screen reader", () => {
      renderList({ running })
      expect(
        within(screen.getByTestId("nav-running-clock")).getByText("Running")
      ).toHaveClass("sr-only")
    })

    it("goes back to its place once it is done", () => {
      const view = renderList({ running })
      view.rerender(
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <SessionViewerHostContext.Provider
            value={{ open: (request) => opened.push(request) }}
          >
            <MessageNavScrollContext.Provider value={null}>
              <MessageNavList entries={entries} onSelect={vi.fn()} />
            </MessageNavScrollContext.Provider>
          </SessionViewerHostContext.Provider>
        </NextIntlClientProvider>
      )
      expect(screen.queryByTestId("nav-running")).not.toBeInTheDocument()
      const labels = screen
        .getAllByTestId("nav-message")
        .map((row) => row.textContent)
      expect(labels[2]).toContain("delete a file")
    })

    it("lists nothing first for a message it doesn't hold", () => {
      renderList({ running: { turnId: "elsewhere", startedAt: null } })
      expect(screen.queryByTestId("nav-running")).not.toBeInTheDocument()
    })
  })

  it("says when an open message was sent", () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-06-12T12:06:30.000Z"))
    try {
      const sentAt = Date.parse("2026-06-12T12:00:00.000Z")
      renderList({
        entries: [
          { ...entries[0], sentAt },
          { ...entries[1], sentAt },
          { ...entries[2], sentAt },
        ],
      })
      // Under the open (latest) message's title…
      expect(screen.getByTestId("nav-row-time")).toHaveTextContent(
        "6 minutes ago"
      )
      expect(
        within(messageButton("delete a file")).getByTestId("nav-row-time")
      ).toBeInTheDocument()
      // …at the end of a row with nothing to open, where a chevron would
      // be, short as the conversation list says it — not on one that has
      // one, whose end sums up its round…
      expect(
        within(messageButton("first message")).getByTestId("nav-row-sent")
      ).toHaveTextContent(/^6m$/)
      expect(screen.getAllByTestId("nav-row-sent")).toHaveLength(1)
      // …and, for any message, in its tooltip.
      expect(messageButton("first message").getAttribute("title")).toMatch(
        /^first message\n.+/
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it("lists nothing without entries", () => {
    renderList({ entries: [] })
    expect(screen.queryAllByRole("listitem")).toHaveLength(0)
  })

  it("jumps to a message when it is clicked", () => {
    const onSelect = vi.fn()
    renderList({ onSelect })
    fireEvent.click(screen.getByText("edit something"))
    expect(onSelect).toHaveBeenCalledWith(entries[1])
  })

  it("numbers each message by its place in the conversation", () => {
    renderList({ entries: [earlierEntry, ...entries] })
    expect(messageButton("an early message")).toHaveTextContent(/^1/)
    expect(messageButton("delete a file")).toHaveTextContent(/^3/)
  })

  it("selects a message above the loaded window like any other", () => {
    const onSelect = vi.fn()
    renderList({ entries: [earlierEntry, ...entries], onSelect })
    fireEvent.click(screen.getByText("an early message"))
    expect(onSelect).toHaveBeenCalledWith(earlierEntry)
  })

  it("marks the message being paged in as busy", () => {
    renderList({
      entries: [earlierEntry, ...entries],
      revealingTurnId: "turn-12",
    })
    expect(messageButton("an early message")).toHaveAttribute(
      "aria-busy",
      "true"
    )
    expect(messageButton("first message")).not.toHaveAttribute("aria-busy")
  })

  it("highlights the message the transcript shows", () => {
    renderList({ currentTurnId: "u2" })
    expect(messageButton("edit something")).toHaveAttribute(
      "aria-current",
      "location"
    )
    expect(messageButton("first message")).not.toHaveAttribute("aria-current")
  })

  it("keeps a message to one line, its whole text on hover", () => {
    renderList()
    expect(messageButton("first message")).toHaveAttribute(
      "title",
      "first message"
    )
  })

  it("says so while the messages above the window are loading", () => {
    renderList({ earlier: "loading" })
    expect(screen.getByText("Loading earlier messages…")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Load earlier messages" })
    ).not.toBeInTheDocument()
  })

  it("offers a retry when the messages above the window failed to load", () => {
    const onRetryEarlier = vi.fn()
    renderList({ earlier: "error", onRetryEarlier })
    fireEvent.click(
      screen.getByRole("button", { name: "Load earlier messages" })
    )
    expect(onRetryEarlier).toHaveBeenCalledTimes(1)
  })

  it("keeps code left to right under a right-to-left interface", () => {
    // A list item's own text-align (`-webkit-match-parent`) turns the list's
    // logical start into a physical right under RTL, which would carry
    // through a diff's dir="ltr" and push its code to the right edge: each
    // row starts its own.
    renderList()
    const rows = screen.getAllByRole("listitem")
    expect(rows).toHaveLength(entries.length)
    for (const row of rows) {
      expect(row.firstElementChild).toHaveClass("text-start")
    }
  })

  it("sums up a closed message's sub-agents and files", () => {
    renderList()
    const edits = messageButton("edit something")
    expect(toggleOf("edit something")).toHaveAttribute("aria-expanded", "false")
    expect(edits).toHaveTextContent("1 sub-agent")
    expect(edits).toHaveTextContent("2 files")
    // Nothing to sum up, nothing to open.
    expect(toggleOf("first message")).toBeNull()
    expect(messageButton("first message")).not.toHaveTextContent("file")
  })

  it("keeps a row's head as it was when the row opens", () => {
    renderList()
    const button = () => messageButton("edit something")
    // The row's own box (the list item's child), the head's, and the
    // title's line box: what places the number and the title's first line.
    const row = () => button().closest("li")!.firstElementChild!
    const title = () => screen.getByText("edit something")
    const shown = () =>
      [...button().querySelectorAll("[aria-hidden='true']")]
        .filter((el) => /^\d+$/.test(el.textContent ?? ""))
        .map((el) => el.textContent)
    const before = {
      row: row().className,
      head: button().className,
      line: title().classList.contains("leading-5"),
      counts: shown(),
    }
    expect(before.line).toBe(true)
    expect(before.counts).toEqual(["1", "2"])
    fireEvent.click(toggleOf("edit something")!)
    expect(toggleOf("edit something")).toHaveAttribute("aria-expanded", "true")
    // No padding over the head an open row lacks, the same head, the same
    // line height, the same counts at its end, none of them hidden: only what
    // is under the head grows.
    expect(row().className).toBe(before.row)
    expect(button().className).toBe(before.head)
    expect(title()).toHaveClass("leading-5")
    expect(shown()).toEqual(before.counts)
    for (const el of button().querySelectorAll("[aria-hidden='true']")) {
      expect(el).not.toHaveClass("hidden")
    }
  })

  // The section header's chevron takes no box and ends on the hairlines'
  // end; a row's sits at its box's end so the two line up, and points the
  // same ways: along the line folded, down open.
  it("ends a row's chevrons where the section header's ends", () => {
    renderList()
    fireEvent.click(messageButton("edit something"))
    const message = toggleOf("edit something")!
    const file = screen.getByRole("button", {
      name: "Show the changes to src/b.ts",
    })
    // Nothing from a chevron up to its list item, the item included, pads,
    // pushes or offsets its end, which would move it off the header's. A
    // zero is no inset.
    // (`inset-*` all round or `inset-x-*`; `inset-y-*` moves nothing sideways.)
    const INSET =
      /^-?(?:p|px|pe|pr|m|mx|me|mr|end|right|inset-x|inset(?!-[xy]-))-(?!0$)/
    for (const toggle of [message, file]) {
      expect(toggle).toHaveClass("justify-end")
      expect(toggle).not.toHaveClass("justify-center")
      const item = toggle.closest("li")
      expect(item).not.toBeNull()
      for (let el: Element = toggle; ; el = el.parentElement!) {
        const inset = [...el.classList].filter((c) => INSET.test(c))
        expect(inset).toEqual([])
        if (el === item) break
      }
    }
    expect(message.querySelector("svg")).not.toHaveClass("-rotate-90")
    expect(file.querySelector("svg")).toHaveClass("-rotate-90")
    fireEvent.click(file)
    const shown = screen
      .getByRole("button", { name: "Hide the changes to src/b.ts" })
      .querySelector("svg")
    // Down, not turned over.
    expect(shown).not.toHaveClass("-rotate-90")
    expect(shown).not.toHaveClass("rotate-180")
  })

  describe("opening a message", () => {
    it("starts with the latest message open and the rest closed", () => {
      renderList()
      expect(toggleOf("delete a file")).toHaveAttribute("aria-expanded", "true")
      expect(screen.getByText("old.ts")).toBeInTheDocument()
      expect(screen.queryByText("a.ts")).not.toBeInTheDocument()
      expect(screen.queryByTestId("nav-sub-agent")).not.toBeInTheDocument()
    })

    it("opens a clicked message, closing the one open before", () => {
      const onSelect = vi.fn()
      renderList({ onSelect })
      fireEvent.click(messageButton("edit something"))
      expect(onSelect).toHaveBeenCalledWith(entries[1])
      expect(toggleOf("edit something")).toHaveAttribute(
        "aria-expanded",
        "true"
      )
      expect(screen.getByText("a.ts")).toBeInTheDocument()
      expect(screen.getByText("b.ts")).toBeInTheDocument()
      expect(screen.getAllByTestId("nav-sub-agent")).toHaveLength(1)
      expect(screen.queryByText("old.ts")).not.toBeInTheDocument()
    })

    it("closes the open message when one with nothing to show is clicked", () => {
      renderList()
      fireEvent.click(messageButton("edit something"))
      fireEvent.click(messageButton("first message"))
      expect(screen.queryByText("a.ts")).not.toBeInTheDocument()
      expect(screen.queryByText("old.ts")).not.toBeInTheDocument()
    })

    it("jumps again from an open message, which stays open", () => {
      const onSelect = vi.fn()
      renderList({ onSelect })
      fireEvent.click(messageButton("delete a file"))
      expect(onSelect).toHaveBeenCalledWith(entries[2])
      expect(screen.getByText("old.ts")).toBeInTheDocument()
    })

    it("closes the open message from its own button, without jumping", () => {
      const onSelect = vi.fn()
      renderList({ onSelect })
      fireEvent.click(screen.getByRole("button", { name: "Collapse" }))
      expect(screen.queryByText("old.ts")).not.toBeInTheDocument()
      expect(onSelect).not.toHaveBeenCalled()
      // Closed by hand, the latest stays closed.
      expect(toggleOf("delete a file")).toHaveAttribute(
        "aria-expanded",
        "false"
      )
    })

    it("opens a message from its chevron, without jumping", () => {
      const onSelect = vi.fn()
      renderList({ onSelect })
      const toggle = toggleOf("edit something")!
      expect(toggle).toHaveAccessibleName("Expand")
      fireEvent.click(toggle)
      expect(onSelect).not.toHaveBeenCalled()
      expect(toggleOf("edit something")).toHaveAttribute(
        "aria-expanded",
        "true"
      )
      expect(toggleOf("edit something")).toHaveAccessibleName("Collapse")
      expect(screen.getByText("a.ts")).toBeInTheDocument()
      // One open at a time.
      expect(screen.queryByText("old.ts")).not.toBeInTheDocument()
    })
  })

  describe("files", () => {
    it("lists a message's files with their line counts, a zero left out", () => {
      renderList()
      fireEvent.click(messageButton("edit something"))
      // The group's heading, not the row's counts read out at its end.
      const heading = screen
        .getAllByText("2 files")
        .find((el) => !el.classList.contains("sr-only"))!
      const card = heading.parentElement as HTMLElement
      expect(card).toHaveTextContent("+5")
      expect(card).not.toHaveTextContent("−")
      expect(fileBox("a.ts")).toHaveTextContent("+2")
      expect(fileBox("b.ts")).toHaveTextContent("+3")
    })

    it("opens a file in the file tabs from its name", () => {
      renderList()
      fireEvent.click(messageButton("edit something"))
      fireEvent.click(screen.getByRole("button", { name: "a.ts" }))
      expect(openFileTarget).toHaveBeenCalledWith("/repo/src/a.ts")
      // Opening the file leaves its diff folded.
      expect(document.querySelector("[data-diff-row]")).toBeNull()
    })

    it("shows a file's diff inline, in the file's box, when its row is clicked", () => {
      renderList()
      fireEvent.click(messageButton("edit something"))
      const box = fileBox("b.ts")
      const chevron = within(box).getByRole("button", {
        name: "Show the changes to src/b.ts",
      })
      expect(chevron).toHaveAttribute("aria-expanded", "false")

      // Anywhere on the row but the name: its folder.
      const folder = box.querySelector("[data-folder]") as HTMLElement
      expect(folder).toHaveTextContent("src")
      fireEvent.click(folder)
      expect(chevron).toHaveAttribute("aria-expanded", "true")
      expect(chevron).toHaveAccessibleName("Hide the changes to src/b.ts")
      const rows = Array.from(box.querySelectorAll("[data-diff-row]"))
      expect(rows.map((r) => r.getAttribute("data-diff-row"))).toEqual([
        "context",
        "deleted",
        "added",
      ])
      expect(within(box).getByText("new line")).toBeInTheDocument()
      expect(openFileTarget).not.toHaveBeenCalled()

      fireEvent.click(chevron)
      expect(document.querySelector("[data-diff-row]")).toBeNull()
    })

    it("unfolds a diff in a panel under the file's line, as the transcript does an edit's", () => {
      renderList()
      fireEvent.click(messageButton("edit something"))
      const box = fileBox("b.ts")
      fireEvent.click(
        within(box).getByRole("button", {
          name: "Show the changes to src/b.ts",
        })
      )
      // The line stays a line — no frame round it and the diff together…
      const line = box.querySelector("[data-testid=nav-file]")!
      expect(box).not.toHaveClass("border")
      expect(line.querySelector("[data-diff-row]")).toBeNull()
      // …and the diff opens in a panel of its own under it: the page colour
      // inside a hairline.
      const panel = line.nextElementSibling as HTMLElement
      expect(panel.querySelectorAll("[data-diff-row]")).toHaveLength(3)
      expect(panel).toHaveClass("border", "border-border", "bg-background")
    })

    it("switches a diff to side by side and back, remembering the panel's own choice", () => {
      renderList()
      fireEvent.click(messageButton("edit something"))
      fireEvent.click(
        screen.getByRole("button", { name: "Show the changes to src/b.ts" })
      )
      fireEvent.click(
        screen.getByRole("button", { name: "Switch to side-by-side view" })
      )
      const cells = Array.from(document.querySelectorAll("[data-diff-cell]"))
      expect(cells.map((c) => c.getAttribute("data-diff-cell"))).toEqual([
        "none",
        "none",
        "deleted",
        "added",
      ])
      expect(document.querySelector("[data-diff-row]")).toBeNull()
      expect(localStorage.getItem("workspace:session-details:diff-view")).toBe(
        "split"
      )
      // The diff previews elsewhere keep their own layout.
      expect(localStorage.getItem("workspace:diff-view-mode")).toBeNull()

      fireEvent.click(
        screen.getByRole("button", { name: "Switch to inline view" })
      )
      expect(document.querySelector("[data-diff-cell]")).toBeNull()
      expect(document.querySelectorAll("[data-diff-row]")).toHaveLength(3)
    })

    it("opens a file's whole diff in a file tab, keyed to its message", () => {
      renderList()
      fireEvent.click(messageButton("edit something"))
      fireEvent.click(
        screen.getByRole("button", { name: "Show the changes to src/b.ts" })
      )
      fireEvent.click(screen.getByRole("button", { name: "View Diff" }))
      expect(openFileTarget).toHaveBeenCalledWith("/repo/src/b.ts", {
        diff: { content: EDIT_DIFF, groupLabel: "u2" },
      })
    })

    // As an edit's diff in the transcript: the switch and the open-in-tab
    // button sit on the diff panel's title bar, not on the file's line.
    it("puts a diff's controls on its panel's title bar", () => {
      renderList()
      fireEvent.click(messageButton("edit something"))
      const box = fileBox("b.ts")
      const line = box.querySelector("[data-testid=nav-file]") as HTMLElement
      expect(
        within(line).queryByRole("button", { name: "View Diff" })
      ).toBeNull()
      fireEvent.click(
        within(line).getByRole("button", {
          name: "Show the changes to src/b.ts",
        })
      )
      expect(
        within(line).queryByRole("button", { name: "View Diff" })
      ).toBeNull()
      expect(
        within(line).queryByRole("button", {
          name: "Switch to side-by-side view",
        })
      ).toBeNull()
      const panel = within(box).getByTestId("nav-file-diff")
      const bar = panel.firstElementChild as HTMLElement
      // The bidi marks that keep the folder in order aside.
      expect(bar.textContent?.replace(/\u200e/g, "")).toContain("src/b.ts")
      expect(
        within(bar).getByRole("button", { name: "View Diff" })
      ).toBeInTheDocument()
      expect(
        within(bar).getByRole("button", {
          name: "Switch to side-by-side view",
        })
      ).toBeInTheDocument()
      // The code is under the bar.
      expect(bar.querySelector("[data-diff-row]")).toBeNull()
      expect(panel.querySelectorAll("[data-diff-row]")).toHaveLength(3)
    })

    it("keeps a file's diff open while its message is closed and reopened", () => {
      renderList()
      fireEvent.click(messageButton("edit something"))
      fireEvent.click(
        screen.getByRole("button", { name: "Show the changes to src/b.ts" })
      )
      fireEvent.click(messageButton("first message"))
      fireEvent.click(messageButton("edit something"))
      expect(within(fileBox("b.ts")).getByText("new line")).toBeInTheDocument()
    })

    it("marks each file's change, and gives a deleted file nothing to open", () => {
      renderList()
      expect(screen.getByTitle("Deleted")).toBeInTheDocument()
      expect(fileBox("old.ts")).toHaveTextContent("−4")
      expect(
        screen.queryByRole("button", { name: "old.ts" })
      ).not.toBeInTheDocument()
      // Its diff still unfolds.
      fireEvent.click(
        screen.getByRole("button", { name: "Show the changes to old.ts" })
      )
      expect(document.querySelectorAll("[data-diff-row=deleted]")).toHaveLength(
        4
      )

      fireEvent.click(messageButton("edit something"))
      expect(screen.getByTitle("Added")).toBeInTheDocument()
      expect(screen.getByTitle("Modified")).toBeInTheDocument()
    })
  })

  describe("sub-agents", () => {
    it("opens a sub-agent's conversation from its card", () => {
      models.set("tu-1", {
        task: "Investigate the flaky test",
        childConversationId: 9,
        status: "running",
      })
      renderList()
      fireEvent.click(messageButton("edit something"))
      const agent = screen.getByTestId("nav-sub-agent")
      expect(agent).toHaveTextContent("Codex")
      expect(agent).toHaveTextContent("Investigate the flaky test")
      expect(agent).toHaveTextContent("running")
      expect(agent).toHaveAttribute("title", "Open conversation")
      fireEvent.click(agent)
      expect(opened).toEqual([
        { kind: "delegation", source: entries[1].subAgents[0] },
      ])
    })

    it("draws a sub-agent as the transcript's activity draws a delegation", () => {
      models.set("tu-1", {
        task: "Investigate the flaky test",
        childConversationId: 9,
        status: "running",
      })
      renderList()
      fireEvent.click(messageButton("edit something"))
      const agent = screen.getByTestId("nav-sub-agent")
      // A line, not a card: its logo in a status ring that turns while it
      // works, how it is doing in words, and the ↗ that says the line opens
      // its conversation.
      expect(agent).not.toHaveClass("border")
      const ring = agent.querySelector("[role=img]")!
      expect(ring.querySelector(".animate-spin")).not.toBeNull()
      expect(within(agent).getByText("running")).toBeInTheDocument()
      expect(agent.querySelector(".lucide-arrow-up-right")).not.toBeNull()
    })

    it("only reports a sub-agent with no conversation to open", () => {
      models.set("tu-1", { childConversationId: null })
      renderList()
      fireEvent.click(messageButton("edit something"))
      const agent = screen.getByTestId("nav-sub-agent")
      expect(agent.tagName).not.toBe("BUTTON")
      expect(agent.querySelector(".lucide-arrow-up-right")).toBeNull()
    })

    it("only reports a sub-agent when there is no viewer to open it in", () => {
      models.set("tu-1", { childConversationId: 9 })
      renderList({}, { host: false })
      fireEvent.click(messageButton("edit something"))
      expect(screen.getByTestId("nav-sub-agent").tagName).not.toBe("BUTTON")
    })

    it("words a failed sub-agent, and marks one brought back", () => {
      models.set("tu-1", { status: "err", errorCode: "timeout" })
      models.set("tu-r", { status: "running" })
      renderList({
        entries: [
          {
            ...entries[1],
            subAgents: [source("tu-1"), source("tu-r", { taskIdHint: "t-1" })],
          },
        ],
      })
      const [failed, resumed] = screen.getAllByTestId("nav-sub-agent")
      expect(failed).toHaveTextContent("timeout")
      // In the failure colour, its ring as well as its words.
      expect(within(failed).getByText("timeout")).toHaveClass(
        "text-tone-danger"
      )
      expect(
        failed.querySelector("[role=img] > .border-tone-danger")
      ).not.toBeNull()
      expect(within(failed).queryByTitle("Resumed")).not.toBeInTheDocument()
      expect(within(resumed).getByTitle("Resumed")).toBeInTheDocument()
    })
  })

  describe("in a scroll area", () => {
    /** A scroll area `height` tall, at its top. Rows are 33px apart from its
     *  top (the virtualizer mock), and the section header covers its top
     *  36px. */
    function scrollArea(height: number): HTMLElement & { height: number } {
      const element = document.createElement("div") as HTMLDivElement & {
        height: number
      }
      element.height = height
      Object.defineProperty(element, "clientHeight", {
        get: () => element.height,
      })
      element.scrollTo = vi.fn() as unknown as typeof element.scrollTo
      return element
    }

    function scrollTo(element: HTMLElement, top: number) {
      act(() => {
        element.scrollTop = top
        element.dispatchEvent(new Event("scroll"))
      })
    }

    it("renders its rows through the virtualizer", () => {
      renderList({}, { scrollElement: scrollArea(500) })
      expect(
        within(screen.getByTestId("virtual-list")).getByText("first message")
      ).toBeInTheDocument()
    })

    it("offers a way back to the current message while it is out of view", async () => {
      // Message 3 starts at 66px; the area shows 0–60.
      const area = scrollArea(60)
      renderList({ currentTurnId: "u3" }, { scrollElement: area })
      const back = await screen.findByRole("button", {
        name: "Scroll to the current message (#3)",
      })
      expect(back).toHaveTextContent("Current message")
      fireEvent.click(back)
      // Centred: its 66px offset, less half of what the area shows besides it.
      expect(area.scrollTo).toHaveBeenCalledWith({
        top: 66 - (60 - 33) / 2,
        behavior: "smooth",
      })

      // Scrolled past it: still out of view, above now.
      scrollTo(area, 200)
      expect(
        screen.getByRole("button", {
          name: "Scroll to the current message (#3)",
        })
      ).toBeInTheDocument()
    })

    // The running message is listed apart, above the virtualized rows.
    it("offers a way back to the current message when it is the running one", () => {
      const area = scrollArea(60)
      renderList(
        {
          currentTurnId: "u3",
          running: { turnId: "u3", startedAt: null },
        },
        { scrollElement: area }
      )
      // It sits 30px into the scrolled content, 40px tall.
      const pinned = screen.getByTestId("nav-running")
      pinned.getBoundingClientRect = () =>
        ({ top: 30 - area.scrollTop, height: 40 }) as DOMRect
      scrollTo(area, 200)
      const back = screen.getByRole("button", {
        name: "Scroll to the current message (#3)",
      })
      fireEvent.click(back)
      expect(area.scrollTo).toHaveBeenCalledWith({
        top: 30 - (60 - 40) / 2,
        behavior: "smooth",
      })
      // Back at the top it is in view again.
      scrollTo(area, 0)
      expect(
        screen.queryByRole("button", { name: /Scroll to the current message/ })
      ).not.toBeInTheDocument()
    })

    it("checks again when the scroll area resizes, without a scroll", async () => {
      const observers: Array<() => void> = []
      const Original = globalThis.ResizeObserver
      globalThis.ResizeObserver = class {
        constructor(callback: () => void) {
          observers.push(callback)
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver
      try {
        const area = scrollArea(120)
        renderList({ currentTurnId: "u3" }, { scrollElement: area })
        await act(
          () => new Promise((resolve) => requestAnimationFrame(resolve))
        )
        expect(
          screen.queryByRole("button", {
            name: /Scroll to the current message/,
          })
        ).not.toBeInTheDocument()

        // The panel shrinks: message 3 (66–99px) falls below the 60px view.
        area.height = 60
        act(() => observers.forEach((notify) => notify()))
        await waitFor(() =>
          expect(
            screen.getByRole("button", {
              name: "Scroll to the current message (#3)",
            })
          ).toBeInTheDocument()
        )
      } finally {
        globalThis.ResizeObserver = Original
      }
    })

    it("fills nothing with an opaque colour a background image would not show through", async () => {
      models.set("tu-1", { childConversationId: 9 })
      const area = scrollArea(60)
      renderList({ currentTurnId: "u3" }, { scrollElement: area })
      await screen.findByRole("button", {
        name: "Scroll to the current message (#3)",
      })
      fireEvent.click(messageButton("edit something"))
      fireEvent.click(
        screen.getByRole("button", { name: "Show the changes to src/b.ts" })
      )
      // Over a workspace background image `ws-msg-card` / `ws-msg-chip` turn
      // a fill translucent (globals.css): every page-coloured or muted fill
      // here — the diff's panel, the button back to the current message —
      // has one.
      // Their tints too (`bg-background/80`): page-coloured all the same.
      const OPAQUE = /^bg-(background|card|muted|secondary|popover)(\/\d+)?$/
      const classes = (el: Element) =>
        (el.getAttribute("class") ?? "").split(/\s+/)
      const filled = [...document.body.querySelectorAll("*")].filter((el) =>
        classes(el).some((c) => OPAQUE.test(c))
      )
      expect(filled.length).toBeGreaterThanOrEqual(2)
      for (const el of filled) {
        expect(classes(el).join(" ")).toMatch(/\bws-msg-(card|chip)\b/)
      }
      // A fade into the page colour is dropped there (`ws-no-fade`)…
      const fades = [
        ...document.body.querySelectorAll("[class*='from-background']"),
      ]
      expect(fades).toHaveLength(1)
      expect(fades[0]).toHaveClass("ws-no-fade")
      // …and the hairlines are the transcript's (`ws-msg-scope`).
      expect(
        screen.getByTestId("virtual-list").closest(".ws-msg-scope")
      ).not.toBeNull()
    })

    it("offers nothing while the current message is in view", async () => {
      const area = scrollArea(120)
      renderList({ currentTurnId: "u3" }, { scrollElement: area })
      // Wait out the first check, which runs after layout.
      await act(() => new Promise((resolve) => requestAnimationFrame(resolve)))
      expect(
        screen.queryByRole("button", { name: /Scroll to the current message/ })
      ).not.toBeInTheDocument()

      // Scrolled away from it: offered.
      scrollTo(area, 400)
      await waitFor(() =>
        expect(
          screen.getByRole("button", {
            name: "Scroll to the current message (#3)",
          })
        ).toBeInTheDocument()
      )
    })
  })
})
