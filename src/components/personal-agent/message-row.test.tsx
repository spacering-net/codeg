import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import zhMessages from "@/i18n/messages/zh-CN.json"
import type { DispatchInfo, TimelineRow } from "@/lib/types"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

const api = vi.hoisted(() => ({
  personalAgentCancel: vi.fn(),
  personalAgentResend: vi.fn(),
  personalAgentTimelineRows: vi.fn(async (): Promise<unknown[]> => []),
  personalAgentNoticeAct: vi.fn(),
  personalAgentBots: vi.fn(async () => []),
}))
const pa = vi.hoisted(() => ({
  dispatchById: new Map<number, unknown>(),
  liveReplies: new Map<number, unknown>(),
  liveTexts: new Map<number, { n: number; text: string }>(),
}))
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock("@/lib/api", () => api)
vi.mock("@/lib/platform", () => ({
  subscribe: () => Promise.resolve(() => {}),
  onTransportReconnect: () => () => {},
}))
vi.mock("sonner", () => ({ toast: toasts }))
vi.mock("@/contexts/personal-agent-context", () => ({
  useBotId: () => null,
  usePersonalAgent: () => ({
    liveReplies: pa.liveReplies,
    liveTexts: pa.liveTexts,
    dispatchById: pa.dispatchById,
    quoted: new Map(),
    requestQuoted: () => {},
    rows: [],
  }),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ setRoute: vi.fn(), openConversations: vi.fn() }),
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({ openTab: vi.fn() }),
}))

import { DispatchAttachments } from "./dispatch-attachments"
import { EventCard } from "./event-card"
import { MessageActions } from "./message-actions"
import { buildMessageItems, type MessageItem } from "./message-items"
import { bubbleCorners, MessageRow } from "./message-row"
import { OwnerBubble } from "./owner-bubble"
import { ReplyBubble, SaidBubble } from "./reply-bubble"
import { AGENT_SURFACE, PageScopeContext, type PageScope } from "./shared"

function row(
  id: number,
  kind: TimelineRow["kind"],
  patch: Partial<TimelineRow> = {}
): TimelineRow {
  return {
    id,
    segment_id: 1,
    batch_id: null,
    kind,
    status: null,
    body: "",
    data: null,
    dispatch_id: null,
    ref_id: null,
    reply_to: null,
    read_at: null,
    event_id: null,
    seen_at: null,
    created_at: "2026-11-04T10:00:00Z",
    updated_at: "2026-11-04T10:00:00Z",
    ...patch,
  }
}

function scope(patch: Partial<PageScope> = {}): PageScope {
  return {
    readOnly: false,
    agentName: "Aide",
    liveRowId: null,
    connectionId: null,
    agentType: null,
    onQuote: vi.fn(),
    jumpTo: vi.fn(),
    rowsById: new Map(),
    ...patch,
  }
}

function draw(node: React.ReactNode, patch: Partial<PageScope> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PageScopeContext.Provider value={scope(patch)}>
        {node}
      </PageScopeContext.Provider>
    </NextIntlClientProvider>
  )
}

function itemOf(rows: TimelineRow[], kind: MessageItem["kind"]) {
  const item = buildMessageItems(rows).find((i) => i.kind === kind)
  if (!item) throw new Error(`no ${kind} item`)
  return item
}

/** The dispatch the work cards point at: a task on the board, run by an
 *  assistant on Codex. */
function dispatchInfo(patch: Partial<DispatchInfo> = {}): DispatchInfo {
  return {
    id: 5,
    mode: "task",
    executor: { assistant_id: 3, name: "Builder", agent_type: "codex" },
    folder_id: 2,
    folder_name: "my-app",
    title: "Add a test page",
    prompt: "Add it",
    work_task_id: 7,
    conversation_id: null,
    conversation_folder_id: null,
    connection_id: null,
    state: "completed",
    updated_at: "2026-11-04T10:00:00Z",
    ...patch,
  } as DispatchInfo
}

function ownerItem(r: TimelineRow) {
  return itemOf([r], "owner") as Extract<MessageItem, { kind: "owner" }>
}

beforeEach(() => {
  toasts.success.mockReset()
  toasts.error.mockReset()
  document.getSelection()?.removeAllRanges()
  api.personalAgentCancel.mockReset()
  api.personalAgentCancel.mockResolvedValue(undefined)
  pa.dispatchById = new Map()
  pa.liveReplies = new Map()
  pa.liveTexts = new Map()
  usePersonalAgentUi.setState({ work: null, workOpen: false })
})

afterEach(cleanup)

const AT = "2026-11-04T10:00:00Z"

/** The frame a right-click on a message opens its menu from. */
function frameOf(container: HTMLElement, id: number): HTMLElement {
  return container.querySelector<HTMLElement>(
    `[data-row-id='${id}'] [data-pa-frame]`
  )!
}

/** A right button's press as the browser sends it, ahead of the menu. */
function pressRight(el: HTMLElement) {
  el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 2 }))
}

/** Select `text`'s characters from `start` to `end` (all of it by
 *  default), as the owner would by dragging over them. */
function selectText(text: Node, start = 0, end = text.textContent!.length) {
  const range = document.createRange()
  range.setStart(text, start)
  range.setEnd(text, end)
  const selection = document.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

/** Right-click `el`, and read the page's selection as the click left it:
 *  after the menu's handler, before the menu takes focus (which, in jsdom
 *  alone, collapses the selection onto it). */
function rightClickReadingSelection(el: HTMLElement): string | null {
  let left: string | null = null
  const read = () => {
    const selection = document.getSelection()!
    left = selection.rangeCount === 0 ? null : selection.toString()
  }
  document.addEventListener("contextmenu", read)
  fireEvent.contextMenu(el)
  document.removeEventListener("contextmenu", read)
  return left
}

describe("MessageRow", () => {
  it("floats the actions under the bubble, taking no room of their own", () => {
    const { container } = draw(
      <MessageRow
        rowId={1}
        side="start"
        gap="side"
        tail
        actions={{ rowId: 1, text: "hello", at: AT }}
      >
        <div data-bubble>hello</div>
      </MessageRow>
    )
    const frame = container.querySelector("[data-row-id='1']")!
    const [bubble, bar] = Array.from(frame.children)
    expect(bubble.querySelector("[data-bubble]")).not.toBeNull()
    expect(bar.hasAttribute("data-pa-actions")).toBe(true)
    expect(bubble.contains(screen.getByRole("button", { name: "Copy" }))).toBe(
      false
    )
    expect(bar.contains(screen.getByRole("button", { name: "Quote" }))).toBe(
      true
    )
    // Out of the flow, under the frame, a little apart from the bubble:
    // showing them moves nothing.
    expect(frame.className).toContain("relative")
    expect(bar.className).toMatch(/(^| )absolute( |$)/)
    expect(bar.className).toContain("top-full")
    expect(bar.className).toContain("pt-1.5")
    expect(bar.className).toContain("start-0")
  })

  it("shows the last message's actions on hover, the others' on keyboard focus alone", () => {
    const { container } = draw(
      <>
        <MessageRow
          rowId={1}
          side="end"
          gap="side"
          tail={false}
          actions={{ rowId: 1, text: "one", at: AT }}
        >
          <div data-bubble>one</div>
        </MessageRow>
        <MessageRow
          rowId={2}
          side="end"
          gap="near"
          tail
          actions={{ rowId: 2, text: "two", at: AT }}
        >
          <div data-bubble>two</div>
        </MessageRow>
      </>
    )
    const [before, last] = Array.from(
      container.querySelectorAll("[data-pa-actions]")
    )
    for (const bar of [before, last]) {
      expect(bar.className).toContain("opacity-0")
      expect(bar.className).toContain("end-0")
      // A clicked button keeps focus: that must not keep them up.
      expect(bar.className).not.toContain("focus-within")
    }
    expect(last.className).toContain("group-hover/msg:opacity-100")
    expect(last.className).toContain(
      "group-has-[:focus-visible]/msg:opacity-100"
    )
    // Right over the next message: never on hover, only when the keyboard
    // brings focus to them.
    expect(before.className).not.toContain("group-hover")
    expect(before.className).toContain("has-[:focus-visible]:opacity-100")
  })

  it("keeps a side's messages 4px apart, whoever speaks, and the other side 32px", () => {
    const { container } = draw(
      <>
        <MessageRow rowId={1} side="start" gap="side" tail={false}>
          <div data-bubble>one</div>
        </MessageRow>
        <MessageRow rowId={2} side="start" gap="near" tail={false}>
          <div data-bubble>two</div>
        </MessageRow>
        <MessageRow rowId={3} side="start" gap="near" tail>
          <div data-bubble>card</div>
        </MessageRow>
      </>
    )
    const [first, second, third] = Array.from(
      container.querySelectorAll("[data-row-id]")
    )
    // The room for the actions of the last message on the other side.
    expect(first.className).toContain("mt-8")
    // Tailwind's spacing is rem: app zoom keeps it in proportion.
    expect(second.className).toContain("mt-1")
    expect(third.className).toContain("mt-1")
    // Under a divider, right there: the divider keeps the room.
    expect(second.className).toContain("[[data-pa-divider]+&]:mt-0")
  })

  it("puts a mark beside the bubble's foot, toward the middle of the list", () => {
    const { container } = draw(
      <>
        <MessageRow
          rowId={1}
          side="end"
          gap="side"
          tail
          aside={<span>mark</span>}
        >
          <div data-bubble>mine</div>
        </MessageRow>
        <MessageRow
          rowId={2}
          side="start"
          gap="side"
          tail
          aside={<span>mark</span>}
        >
          <div data-bubble>theirs</div>
        </MessageRow>
      </>
    )
    const [end, start] = Array.from(
      container.querySelectorAll("[data-pa-aside]")
    )
    // Beside the bubble, in its frame, out of the flow.
    expect(end.parentElement!.querySelector("[data-bubble]")).not.toBeNull()
    expect(end.className).toMatch(/(^| )absolute( |$)/)
    expect(end.className).toContain("end-full")
    expect(start.className).toContain("start-full")
  })

  it("puts a state that stays on a line under the bubble, in the flow", () => {
    const { container } = draw(
      <MessageRow
        rowId={3}
        side="end"
        gap="side"
        tail
        below={<div data-testid="state" />}
        actions={{ rowId: 3, text: "hello", at: AT }}
      >
        <div data-bubble>hello</div>
      </MessageRow>
    )
    const frame = container.querySelector("[data-row-id='3']")!
    expect(frame.children[1]).toBe(screen.getByTestId("state"))
    expect(frame.children[2].hasAttribute("data-pa-actions")).toBe(true)
  })

  it("gives a message holding cards at least a card's width", () => {
    const { container } = draw(
      <MessageRow rowId={4} side="start" gap="side" tail roomy>
        <div data-bubble>cards</div>
      </MessageRow>
    )
    const frame = container.querySelector("[data-row-id='4']")!
    expect(frame.firstElementChild!.className).toContain(
      "min-w-[min(22rem,88%)]"
    )
  })
})

describe("the message menu", () => {
  function drawRow(
    patch: Partial<PageScope> = {},
    spec: Partial<React.ComponentProps<typeof MessageRow>["actions"]> = {}
  ) {
    return draw(
      <MessageRow
        rowId={7}
        side="start"
        gap="side"
        tail={false}
        actions={{ rowId: 7, text: "The whole reply", at: AT, ...spec }}
      >
        <div data-bubble>
          <p data-testid="text">The whole reply</p>
          <span data-testid="own" onContextMenu={(e) => e.preventDefault()}>
            link
          </span>
        </div>
      </MessageRow>,
      patch
    )
  }

  it("opens the bar's actions on a right-click, with the time at its foot", async () => {
    const { container } = drawRow()
    const frame = frameOf(container, 7)
    fireEvent.contextMenu(frame)
    const items = await screen.findAllByRole("menuitem")
    expect(items.map((i) => i.textContent)).toEqual(["Quote", "Copy"])
    // Each with the bar's icon.
    for (const item of items) expect(item.querySelector("svg")).not.toBeNull()
    expect(document.querySelector("[data-pa-menu-time]")?.textContent).toBe(
      new Date(AT).toLocaleString("en", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    )
    // The bubble it is about is ringed while it is open.
    expect(frame.getAttribute("data-state")).toBe("open")
  })

  it("quotes and copies from the menu, confirming the copy", async () => {
    const quote = vi.fn()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    })
    const { container } = drawRow({ onQuote: quote })
    fireEvent.contextMenu(frameOf(container, 7))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Quote" }))
    expect(quote).toHaveBeenCalledWith(7)
    fireEvent.contextMenu(frameOf(container, 7))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy" }))
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("The whole reply")
    )
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Copied"))
  })

  it("offers to copy what of the bubble is selected, first", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    })
    const { container } = drawRow()
    // "whole", of "The whole reply".
    selectText(screen.getByTestId("text").firstChild!, 4, 9)
    const frame = frameOf(container, 7)
    pressRight(frame)
    // The owner's selection stays.
    expect(rightClickReadingSelection(frame)).toBe("whole")
    const items = await screen.findAllByRole("menuitem")
    expect(items.map((i) => i.textContent)).toEqual([
      "Copy selection",
      "Quote",
      "Copy",
    ])
    fireEvent.click(items[0])
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("whole"))
  })

  it("drops the word a right press selected on its own", async () => {
    const { container } = drawRow()
    const frame = frameOf(container, 7)
    document.getSelection()!.removeAllRanges()
    pressRight(frame)
    // What macOS does between the press and the menu: the word under the
    // pointer, for the system's own menu.
    selectText(screen.getByTestId("text").firstChild!, 4, 9)
    expect(rightClickReadingSelection(frame)).toBeNull()
    const items = await screen.findAllByRole("menuitem")
    expect(items.map((i) => i.textContent)).toEqual(["Quote", "Copy"])
  })

  it("offers a selection the keyboard's menu key finds, with no press before it", async () => {
    const { container } = drawRow()
    selectText(screen.getByTestId("text").firstChild!, 4, 9)
    expect(rightClickReadingSelection(frameOf(container, 7))).toBe("whole")
    const items = await screen.findAllByRole("menuitem")
    expect(items[0].textContent).toBe("Copy selection")
  })

  it("leaves a right-click to a menu of its own inside the bubble", () => {
    drawRow()
    fireEvent.contextMenu(screen.getByTestId("own"))
    expect(screen.queryByRole("menu")).toBeNull()
  })

  it("writes its time in the page's language, as the bar does", async () => {
    const { container } = render(
      <NextIntlClientProvider locale="zh-CN" messages={zhMessages}>
        <PageScopeContext.Provider value={scope()}>
          <MessageRow
            rowId={9}
            side="end"
            gap="side"
            tail
            actions={{ rowId: 9, text: "hi", at: AT }}
          >
            <div data-bubble>hi</div>
          </MessageRow>
        </PageScopeContext.Provider>
      </NextIntlClientProvider>
    )
    expect(
      container.querySelector("[data-pa-actions] span.tabular-nums")
        ?.textContent
    ).toBe(
      new Date(AT).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
      })
    )
    fireEvent.contextMenu(frameOf(container, 9))
    const items = await screen.findAllByRole("menuitem")
    expect(items.map((i) => i.textContent)).toEqual(["引用", "复制"])
    expect(document.querySelector("[data-pa-menu-time]")?.textContent).toBe(
      new Date(AT).toLocaleString("zh-CN", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    )
  })

  it("offers no quote or stop on a read-only page", async () => {
    const { container } = drawRow({ readOnly: true }, { live: true })
    fireEvent.contextMenu(frameOf(container, 7))
    const items = await screen.findAllByRole("menuitem")
    expect(items.map((i) => i.textContent)).toEqual(["Copy"])
  })
})

describe("MessageActions", () => {
  it("stops the reply being written", () => {
    draw(<MessageActions rowId={5} text={null} at="" live side="start" />)
    fireEvent.click(screen.getByRole("button", { name: "Stop the reply" }))
    expect(api.personalAgentCancel).toHaveBeenCalledTimes(1)
  })

  it("answers a hover with the icon's colour alone, no fill", () => {
    draw(<MessageActions rowId={5} text="hi" at="" live side="start" />)
    for (const name of ["Stop the reply", "Quote", "Copy"]) {
      const button = screen.getByRole("button", { name })
      expect(button.className).toContain("hover:text-foreground")
      expect(button.className).not.toMatch(/hover:bg-/)
    }
  })

  it("offers no stop on a settled reply, nor on a read-only page", () => {
    draw(<MessageActions rowId={5} text="hi" at="" side="start" />)
    expect(screen.queryByRole("button", { name: "Stop the reply" })).toBeNull()
    cleanup()
    draw(<MessageActions rowId={5} text={null} at="" live side="start" />, {
      readOnly: true,
    })
    expect(screen.queryByRole("button", { name: "Stop the reply" })).toBeNull()
  })
})

describe("the bubbles", () => {
  /** A turn that wrote "I'll hand it to Dev." (step 1), sent Dev a message
   *  (step 2) and goes on: its reply row `2`, the line `3`. */
  function handedTurn(reply: Partial<TimelineRow>) {
    const items = buildMessageItems([
      row(2, "reply", { batch_id: 7, ...reply }),
      row(3, "exchange", {
        batch_id: 7,
        body: "Fix the login bug.",
        data: {
          direction: "out",
          peer: { id: 5, name: "Dev" },
          turn: { n: 2, said: { n: 1, text: "I'll hand it to Dev." } },
        },
      }),
    ])
    const said = items.find((i) => i.kind === "said") as Extract<
      MessageItem,
      { kind: "said" }
    >
    const reply2 = items.find((i) => i.kind === "reply") as Extract<
      MessageItem,
      { kind: "reply" }
    >
    return { said, reply: reply2 }
  }

  it("keeps what a turn wrote before a message it sent, to copy, not to quote", async () => {
    const { said } = handedTurn({ data: { state: "running" } })
    const { container } = draw(<SaidBubble item={said} />)
    const bubble = container.querySelector("[data-pa-said]")!
    expect(bubble.textContent).toBe("I'll hand it to Dev.")
    // No row of its own: jumps land on the line, not on it.
    expect(container.querySelector("[data-row-id]")).toBeNull()
    fireEvent.contextMenu(bubble)
    const items = await screen.findAllByRole("menuitem")
    const words = items.map((i) => i.textContent)
    expect(words).toContain("Copy")
    expect(words).not.toContain("Quote")
  })

  it("does not draw again, while the turn runs, the text drawn over its line", () => {
    // The turn is on a step after the message; the bubble would keep its
    // last text, which is the one over the line.
    pa.liveReplies.set(2, {
      t: "step",
      n: 3,
      kind: "read",
      title: "Read notes.md",
    })
    pa.liveTexts.set(2, { n: 1, text: "I'll hand it to Dev." })
    const { reply } = handedTurn({ data: { state: "running" } })
    expect(reply.saidNs).toEqual([1])
    const { container, unmount } = draw(<ReplyBubble item={reply} />)
    expect(container.querySelector("[data-bubble]")).toBeNull()
    unmount()
    // What it writes next is its own again.
    pa.liveReplies.set(2, { t: "text", n: 4, text: "Dev has it." })
    pa.liveTexts.set(2, { n: 4, text: "Dev has it." })
    const again = draw(<ReplyBubble item={reply} />)
    expect(again.container.querySelector("[data-bubble]")?.textContent).toBe(
      "Dev has it."
    )
  })

  it("splits a reply of short paragraphs into bubbles that act as one", async () => {
    const item = itemOf(
      [
        row(8, "reply", {
          batch_id: 7,
          body: "Done.\n\nThe build is green.\n\nNext: the PR.",
          data: { state: "done" },
        }),
      ],
      "reply"
    ) as Extract<MessageItem, { kind: "reply" }>
    const { container } = draw(<ReplyBubble item={item} />)
    const bubbles = [...container.querySelectorAll("[data-bubble]")]
    expect(bubbles.map((b) => b.textContent)).toEqual([
      "Done.",
      "The build is green.",
      "Next: the PR.",
    ])
    expect(bubbles.map((b) => b.getAttribute("data-pa-bubble-part"))).toEqual([
      "0",
      "1",
      "2",
    ])
    // One message: one frame, its menu from any of them.
    expect(container.querySelectorAll("[data-row-id='8']")).toHaveLength(1)
    fireEvent.contextMenu(bubbles[0])
    const items = await screen.findAllByRole("menuitem")
    expect(items.map((i) => i.textContent)).toContain("Quote")
  })

  it("names a reply that is the morning brief or the wrap-up (6.4)", () => {
    for (const [kind, words] of [
      ["brief", "Morning brief"],
      ["wrap", "Wrap-up of the day"],
    ] as const) {
      const item = itemOf(
        [
          row(10, "reply", {
            batch_id: 7,
            body: "Good morning.",
            data: { state: "done", brief: { id: 3, kind } },
          }),
        ],
        "reply"
      ) as Extract<MessageItem, { kind: "reply" }>
      const { container, unmount } = draw(<ReplyBubble item={item} />)
      const tag = container.querySelector("[data-pa-reply-brief]")
      expect(tag?.getAttribute("data-pa-reply-brief")).toBe(kind)
      expect(tag?.textContent).toBe(words)
      unmount()
    }
  })

  it("shows last night's tidy-ups under a morning brief it wrote (7.7)", () => {
    const line = {
      key: "tidy:9",
      kind: "tidy",
      bot_id: 2,
      project: null,
      title: "Tidied memory (2026-11-12) — 1 updated",
      text: null,
      at: "2026-11-12T19:00:00Z",
      state: "acted",
      row_id: 41,
      dispatch_id: null,
      task_id: null,
      conversation_id: null,
      item_id: null,
      notice_id: 9,
      agent_type: null,
      undo: true,
    }
    for (const [kind, shown] of [
      ["brief", true],
      ["wrap", false],
    ] as const) {
      const item = itemOf(
        [
          row(10, "reply", {
            batch_id: 7,
            body: "Good morning.",
            data: { state: "done", brief: { id: 3, kind, tidied: [line] } },
          }),
        ],
        "reply"
      ) as Extract<MessageItem, { kind: "reply" }>
      const { container, unmount } = draw(<ReplyBubble item={item} />)
      expect(container.querySelector("[data-pa-brief-tidied]") != null).toBe(
        shown
      )
      if (shown) {
        expect(
          container.querySelector("[data-pa-tidy-line='acted']")
        ).toBeTruthy()
      }
      unmount()
    }
  })

  it("names the memory a reply used, each opening its entry (7.7)", () => {
    usePersonalAgentUi.setState({ settings: null })
    const item = itemOf(
      [
        row(11, "reply", {
          batch_id: 7,
          body: "On Fridays.",
          data: {
            state: "done",
            memories: [
              { name: "memory/release.md", title: "Release days" },
              { name: "memory/hours.md", title: "Your hours" },
              { name: "USER.md", title: "not an entry" },
            ],
          },
        }),
      ],
      "reply"
    ) as Extract<MessageItem, { kind: "reply" }>
    const { container } = draw(<ReplyBubble item={item} />)
    const line = container.querySelector("[data-pa-reply-memories]")
    expect(line?.textContent).toBe("Memory used:Release days·Your hours")
    fireEvent.click(screen.getByText("Your hours"))
    expect(usePersonalAgentUi.getState().settings).toEqual({
      page: "persona",
      bot: null,
      entry: "memory/hours.md",
    })
  })

  it("keeps a reply with code in one bubble", () => {
    const item = itemOf(
      [
        row(9, "reply", {
          batch_id: 7,
          body: "Run this:\n\n```sh\npnpm test\n```\n\nThat is all.",
          data: { state: "done" },
        }),
      ],
      "reply"
    ) as Extract<MessageItem, { kind: "reply" }>
    const { container } = draw(<ReplyBubble item={item} />)
    expect(container.querySelectorAll("[data-bubble]")).toHaveLength(1)
    expect(container.querySelector("[data-pa-bubble-part]")).toBeNull()
  })

  it("shows the brain's answered question as its folded choice card", () => {
    const item = itemOf(
      [
        row(10, "reply", {
          batch_id: 7,
          body: "Looking at local changes.",
          data: { state: "done" },
        }),
        row(11, "question", {
          batch_id: 7,
          ref_id: "q-1",
          data: {
            kind: "ask",
            state: "answered",
            questions: [
              {
                id: "a",
                question: "Where first?",
                header: "",
                multi_select: false,
                options: [
                  { label: "The PR", description: "" },
                  { label: "Local changes", description: "" },
                ],
              },
            ],
            answer: {
              answers: [
                { question: "Where first?", selected: ["Local changes"] },
              ],
            },
          },
        }),
      ],
      "reply"
    ) as Extract<MessageItem, { kind: "reply" }>
    draw(<ReplyBubble item={item} />)
    expect(screen.getByText("You picked: B. Local changes")).toBeInTheDocument()
    expect(screen.queryByText(/Your answer:/)).toBeNull()
  })

  it("starts a reply that ended with no text on its ending, with nothing above it", () => {
    const item = itemOf(
      [
        row(3, "reply", {
          batch_id: 7,
          data: { state: "interrupted", why: "restart" },
        }),
      ],
      "reply"
    ) as Extract<MessageItem, { kind: "reply" }>
    const { container } = draw(<ReplyBubble item={item} />)
    const bubble = container.querySelector("[data-bubble]")!
    expect(bubble.firstElementChild?.textContent).toBe(
      "This reply did not finish: codeg restarted"
    )
  })

  it("says a reply made way for the owner's message without an alarm", () => {
    const item = itemOf(
      [
        row(3, "reply", {
          batch_id: 7,
          data: { state: "interrupted", why: "preempted" },
        }),
      ],
      "reply"
    ) as Extract<MessageItem, { kind: "reply" }>
    const { container } = draw(<ReplyBubble item={item} />)
    const ending = container.querySelector("[data-bubble]")!
      .firstElementChild as HTMLElement
    expect(ending.textContent).toBe("Stopped to make way for your message")
    expect(ending.className).toContain("text-muted-foreground")
    expect(ending.className).not.toContain("text-amber-700")
  })

  it("stops a reply while it is written, from its actions or its menu", async () => {
    const item = itemOf(
      [
        row(4, "reply", {
          batch_id: 7,
          data: {
            state: "running",
            current: { t: "text", n: 1, text: "Looking at it." },
          },
        }),
      ],
      "reply"
    ) as Extract<MessageItem, { kind: "reply" }>
    const { container } = draw(<ReplyBubble item={item} />, { liveRowId: 4 })
    fireEvent.click(screen.getByRole("button", { name: "Stop the reply" }))
    expect(api.personalAgentCancel).toHaveBeenCalledTimes(1)
    fireEvent.contextMenu(frameOf(container, 4))
    const items = await screen.findAllByRole("menuitem")
    expect(items.map((i) => i.textContent)).toEqual(["Stop the reply", "Quote"])
    fireEvent.click(items[0])
    await waitFor(() =>
      expect(api.personalAgentCancel).toHaveBeenCalledTimes(2)
    )
  })

  it("draws a card's speaker inside it, on the work's row, with no avatar beside the card", () => {
    const item = itemOf(
      [
        row(6, "result", {
          body: "Build the page",
          data: {
            executor: "Builder",
            executor_id: 3,
            title: "Build the page",
            mode: "task",
            state: "completed",
          },
        }),
      ],
      "event"
    ) as Extract<MessageItem, { kind: "event" }>
    const { container } = draw(<EventCard item={item} />)
    const frame = container.querySelector("[data-row-id='6']")!
    const avatars = frame.querySelectorAll("[data-slot='assistant-avatar']")
    expect(avatars).toHaveLength(1)
    const work = frame.querySelector("[data-pa-work]")!
    expect(frame.querySelector("[data-bubble]")!.contains(work)).toBe(true)
    // The row a reply's card is: the avatar, the title over who ran it as
    // what, how it stood — in the words the reply's card uses.
    expect(work.firstElementChild).toBe(avatars[0])
    const [title, meta] = Array.from(work.children[1].children)
    expect(title.textContent).toBe("Build the page")
    expect(meta.textContent).toBe("Builder · Kanban task")
    expect(work.children[2].textContent).toBe("Done")
    // Unread until the assistant starts on it, beside the card.
    expect(frame.querySelector("[data-pa-aside]")?.textContent).toBe("Unread")
  })

  it("keeps a reply's work to a pill, and leaves the agent's mark and the rest to the news", () => {
    pa.dispatchById = new Map([[5, dispatchInfo({ state: "completed" })]])
    const reply = draw(
      <DispatchAttachments
        rows={[
          row(20, "dispatch", {
            body: "Add a test page",
            dispatch_id: 5,
            data: { mode: "task", executor: "Builder", executor_id: 3 },
          }),
        ]}
      />
    )
    const pill = reply.container.querySelector<HTMLElement>(
      "[data-pa-work-pill]"
    )!
    // Who runs it (their avatar, without the agent's mark, and name) and
    // what it is, then how it stands as an icon (its word for a screen
    // reader and a pointer) — no kind or place.
    const avatar = pill.querySelector<HTMLElement>(
      "[data-slot='assistant-avatar']"
    )!
    expect(avatar.style.width).toBe("1.25rem")
    expect(pill.firstElementChild).toBe(avatar)
    expect(pill.querySelector("[data-pa-agent-badge]")).toBeNull()
    expect(pill.querySelector("[title='Done'] svg")).not.toBeNull()
    expect(pill.querySelector(".sr-only")?.textContent).toBe("Done")
    expect(pill.textContent).toBe("BBuilder·Add a test pageDone")
    expect(pill.title).toBe("View session")
    const news = draw(
      <EventCard
        item={
          itemOf(
            [
              row(21, "result", {
                body: "Add a test page",
                dispatch_id: 5,
                data: {
                  executor: "Builder",
                  executor_id: 3,
                  title: "Add a test page",
                  mode: "task",
                  state: "completed",
                  work_task_id: 7,
                  excerpt: "Added it.",
                },
              }),
            ],
            "event"
          ) as Extract<MessageItem, { kind: "event" }>
        }
      />
    )
    // The news says the rest: the avatar with its agent's mark, the kind of
    // work and where, the state in a chip — its result under that.
    const head = news.container.querySelector("[data-pa-work]")!
    expect(head.querySelector("[data-pa-agent-badge] title")?.textContent).toBe(
      "Codex"
    )
    expect(head.textContent).toContain("Builder · Kanban task · my-app")
    expect(head.children[2].textContent).toBe("Done")
    const result = news.container.querySelector("[data-pa-result]")!
    expect(result.previousElementSibling).toBe(head.parentElement)
    expect(result.textContent).toBe("Added it.")
  })

  it("tints the assistant's side with no border, and washes what sits inside a step deeper", () => {
    expect(AGENT_SURFACE).toBe("pa-agent-bubble")
    pa.dispatchById = new Map([[5, dispatchInfo({ state: "running" })]])
    const { container } = draw(
      <EventCard
        item={
          itemOf(
            [
              row(21, "result", {
                body: "Add a test page",
                dispatch_id: 5,
                data: { executor: "Builder", state: "running", mode: "task" },
              }),
            ],
            "event"
          ) as Extract<MessageItem, { kind: "event" }>
        }
      />
    )
    const bubble = container.querySelector<HTMLElement>("[data-bubble]")!
    expect(bubble.classList.contains("pa-agent-bubble")).toBe(true)
    expect(bubble.className).not.toMatch(/(^|\s)border(\s|$)/)
    // The well only clips; the row filling it is the surface, a step deeper
    // under the pointer and when pressed.
    const workRow = container.querySelector<HTMLElement>("[data-pa-work]")!
    expect(workRow.parentElement!.className).toBe("overflow-hidden rounded-xl")
    expect(workRow.className).toContain("bg-(--pa-inset)")
    expect(workRow.className).toContain("hover:bg-(--pa-inset-hover)")
    expect(workRow.className).toContain("active:bg-(--pa-inset-active)")
    cleanup()
    const pills = draw(
      <DispatchAttachments
        rows={[
          row(20, "dispatch", {
            body: "Add a test page",
            dispatch_id: 5,
            data: { mode: "task", executor: "Builder", executor_id: 3 },
          }),
        ]}
      />
    )
    const pill = pills.container.querySelector("[data-pa-work-pill]")!
    expect(pill.className).toContain("bg-(--pa-inset)")
    expect(pill.className).toContain("hover:bg-(--pa-inset-hover)")
    expect(pill.className).toContain("active:bg-(--pa-inset-active)")
  })

  it("holds a side's run together at its corners, and closes it round", () => {
    expect(bubbleCorners("start", false)).toBe(
      "rounded-[1.375rem] rounded-ss-[0.375rem] rounded-es-[0.375rem]"
    )
    expect(bubbleCorners("start", true)).toBe(
      "rounded-[1.375rem] rounded-ss-[0.375rem]"
    )
    expect(bubbleCorners("end", false)).toBe(
      "rounded-[1.375rem] rounded-se-[0.375rem] rounded-ee-[0.375rem]"
    )
    expect(bubbleCorners("end", true)).toBe(
      "rounded-[1.375rem] rounded-se-[0.375rem]"
    )
    // Each kind of bubble draws them: two of the owner's, then a reply and
    // the news after it on the other side.
    const items = buildMessageItems([
      row(1, "owner", { body: "one", status: "answered" }),
      row(2, "owner", { body: "two", status: "answered" }),
      row(3, "reply", { batch_id: 9, data: { state: "done" } }),
      row(4, "result", { body: "Work", data: { title: "Work" } }),
    ])
    const [one, two, reply, news] = items.filter((i) => i.kind !== "time")
    const { container } = draw(
      <>
        <OwnerBubble item={one as Extract<MessageItem, { kind: "owner" }>} />
        <OwnerBubble item={two as Extract<MessageItem, { kind: "owner" }>} />
        <ReplyBubble item={reply as Extract<MessageItem, { kind: "reply" }>} />
        <EventCard item={news as Extract<MessageItem, { kind: "event" }>} />
      </>
    )
    const corners = (id: number) =>
      container.querySelector(`[data-row-id='${id}'] [data-bubble]`)!.className
    expect(corners(1)).toContain(bubbleCorners("end", false))
    expect(corners(2)).toContain(bubbleCorners("end", true))
    expect(corners(2)).not.toContain("rounded-ee-")
    expect(corners(3)).toContain(bubbleCorners("start", false))
    expect(corners(4)).toContain(bubbleCorners("start", true))
    expect(corners(4)).not.toContain("rounded-es-")
  })

  it("marks an executor's avatar with its agent, at the avatar's foot", () => {
    const card = (id: number, data: Record<string, unknown>) =>
      itemOf(
        [
          row(id, "result", {
            body: "Work",
            data: { executor: "Builder", title: "Work", ...data },
          }),
        ],
        "event"
      ) as Extract<MessageItem, { kind: "event" }>
    const { container } = draw(
      <EventCard item={card(16, { agent_type: "codex" })} />
    )
    const work = container.querySelector("[data-pa-work]")!
    const badged = work.firstElementChild as HTMLElement
    expect(badged.hasAttribute("data-pa-badged")).toBe(true)
    expect(badged.firstElementChild?.getAttribute("data-slot")).toBe(
      "assistant-avatar"
    )
    const badge = badged.querySelector<HTMLElement>("[data-pa-agent-badge]")!
    expect(badge.querySelector("title")?.textContent).toBe("Codex")
    // 14px on the 32px avatar, 2px out past its bottom end corner, in rem;
    // the hole cut around it 1.5px wider (globals.css reads the variables).
    expect(badge.style.width).toBe("0.875rem")
    expect(badge.style.bottom).toBe("-0.125rem")
    expect(badge.style.insetInlineEnd).toBe("-0.125rem")
    expect(badged.style.getPropertyValue("--pa-badge-center")).toBe("0.3125rem")
    expect(badged.style.getPropertyValue("--pa-badge-hole")).toBe("0.53125rem")
    // Out of the accessible name: the line beside it names the assistant.
    expect(badge.getAttribute("aria-hidden")).toBe("true")
    cleanup()
    // An agent the row never recorded: the avatar alone.
    const bare = draw(<EventCard item={card(17, {})} />)
    const plain = bare.container.querySelector("[data-pa-work]")!
    expect(plain.querySelector("[data-pa-badged]")).toBeNull()
    expect(plain.firstElementChild?.getAttribute("data-slot")).toBe(
      "assistant-avatar"
    )
  })

  it("draws a card's result as markdown, not as its marks", () => {
    const item = itemOf(
      [
        row(10, "result", {
          body: "Build",
          data: {
            executor: "Builder",
            title: "Run the build",
            excerpt: "## Build: ok\n\n**Exit code**: `0`\n\n- one\n- two",
          },
        }),
      ],
      "event"
    ) as Extract<MessageItem, { kind: "event" }>
    const { container } = draw(<EventCard item={item} />)
    const bubble = container.querySelector("[data-bubble]")!
    expect(bubble.querySelector("h2")?.textContent).toBe("Build: ok")
    expect(
      bubble.querySelector('[data-streamdown="strong"]')?.textContent
    ).toBe("Exit code")
    expect(bubble.querySelector("code")?.textContent).toBe("0")
    expect(bubble.querySelectorAll("li")).toHaveLength(2)
    expect(bubble.textContent).not.toContain("**")
    expect(bubble.textContent).not.toContain("##")
  })

  it("opens a card's session in the drawer, from the dispatch as it is now", () => {
    pa.dispatchById = new Map([
      [
        9,
        {
          id: 9,
          mode: "chat",
          executor: { assistant_id: 3, name: "Scout", agent_type: "codex" },
          folder_id: null,
          title: "Research the topic",
          prompt: "Look into it",
          work_task_id: null,
          conversation_id: 41,
          conversation_folder_id: 7,
          connection_id: "c-1",
          state: "running",
        } as DispatchInfo,
      ],
    ])
    const item = itemOf(
      [
        row(11, "result", {
          body: "Research",
          dispatch_id: 9,
          data: {
            executor: "Scout",
            title: "Research the topic",
            mode: "chat",
            state: "completed",
            conversation_id: 41,
            conversation_folder_id: 7,
            agent_type: "codex",
            executor_id: 3,
          },
        }),
      ],
      "event"
    ) as Extract<MessageItem, { kind: "event" }>
    const { container } = draw(<EventCard item={item} />)
    const open = container.querySelector<HTMLButtonElement>("[data-pa-work]")!
    expect(open.disabled).toBe(false)
    expect(open.title).toBe("View session")
    // How the work stood when the news came, not how it stands now.
    expect(open.textContent).toContain("Done")
    expect(open.textContent).not.toContain("Running")
    fireEvent.click(open)
    const ui = usePersonalAgentUi.getState()
    expect(ui.workOpen).toBe(true)
    expect(ui.work).toEqual({
      dispatchId: 9,
      mode: "chat",
      workTaskId: null,
      conversationId: 41,
      folderId: 7,
      agentType: "codex",
      title: "Research the topic",
      executorId: 3,
      executorName: "Scout",
      prompt: "Look into it",
      connectionId: "c-1",
      state: "running",
    })
  })

  it("words the notes codeg writes itself, and shows an agent's own as it came", () => {
    const card = (id: number, data: Record<string, unknown>) =>
      itemOf(
        [row(id, "result", { body: "Work", data: { title: "Work", ...data } })],
        "event"
      ) as Extract<MessageItem, { kind: "event" }>
    const { container } = draw(
      <EventCard item={card(13, { note: "codeg restarted", cause: "boot" })} />
    )
    expect(container.textContent).toContain("codeg restarted")
    cleanup()
    const zh = render(
      <NextIntlClientProvider locale="zh-CN" messages={zhMessages}>
        <PageScopeContext.Provider value={scope()}>
          <EventCard
            item={card(14, { note: "the task was deleted", cause: "gone" })}
          />
        </PageScopeContext.Provider>
      </NextIntlClientProvider>
    )
    expect(zh.container.textContent).toContain("看板上的任务被删除了")
    expect(zh.container.textContent).not.toContain("the task was deleted")
    cleanup()
    const own = draw(
      <EventCard
        item={card(15, { note: "rate limit reached", cause: "turn" })}
      />
    )
    expect(own.container.textContent).toContain("rate limit reached")
  })

  it("offers no session on a card whose task was never made", () => {
    const item = itemOf(
      [
        row(12, "result", {
          body: "Task",
          data: { executor: "Builder", title: "Task", mode: "task" },
        }),
      ],
      "event"
    ) as Extract<MessageItem, { kind: "event" }>
    const { container } = draw(<EventCard item={item} />)
    const work = container.querySelector<HTMLButtonElement>("[data-pa-work]")!
    expect(work.disabled).toBe(true)
    expect(work.hasAttribute("title")).toBe(false)
    expect(work.querySelector(".lucide-chevron-right")).toBeNull()
  })

  it("says unread beside the owner's bubble, and nothing once it was read", () => {
    const { container } = draw(
      <OwnerBubble
        item={ownerItem(row(8, "owner", { body: "hi", status: "queued" }))}
      />
    )
    const aside = container.querySelector("[data-row-id='8'] [data-pa-aside]")
    expect(aside?.textContent).toBe("Unread")
    cleanup()
    const read = draw(
      <OwnerBubble
        item={ownerItem(
          row(9, "owner", {
            body: "hi",
            status: "answered",
            read_at: "2026-11-04T10:00:01Z",
          })
        )}
      />
    )
    expect(read.container.querySelector("[data-pa-aside]")).toBeNull()
    expect(read.container.textContent).not.toContain("Read")
  })

  it("says a message never finished on a line under it, with the way to send it again", () => {
    api.personalAgentResend.mockResolvedValue(undefined)
    const { container } = draw(
      <OwnerBubble
        item={ownerItem(
          row(10, "owner", { body: "hi", status: "interrupted" })
        )}
      />
    )
    expect(container.querySelector("[data-pa-aside]")).toBeNull()
    const line = container.querySelector("[data-pa-state]")!
    expect(line.textContent).toContain("Not finished")
    fireEvent.click(screen.getByRole("button", { name: /Send again/ }))
    expect(api.personalAgentResend).toHaveBeenCalledWith(10, null)
  })

  it("says a message was folded into the reply being written", () => {
    const { container } = draw(
      <OwnerBubble
        item={ownerItem(
          row(11, "owner", {
            body: "and this",
            status: "delivered",
            read_at: "2026-11-09T10:00:00Z",
            data: { merged: true },
          })
        )}
      />
    )
    const line = container.querySelector("[data-pa-state]")!
    expect(line.textContent).toBe("Folded into the reply in progress")
    expect(screen.queryByRole("button", { name: /Send again/ })).toBeNull()
    expect(container.querySelector("[data-pa-aside]")).toBeNull()
  })

  it("shows under the message the reminders it brought up (6.8)", () => {
    const hit = {
      item_id: 3,
      bot_id: 1,
      by: "Ada",
      keyword: "release",
      text: "Update the Homebrew formula first",
      times: 1,
      max_times: 3,
    }
    const { container } = draw(
      <OwnerBubble
        item={ownerItem(
          row(12, "owner", {
            body: "let's cut the release",
            status: "delivered",
            read_at: "2026-11-09T10:00:00Z",
            data: { merged: true, mentioned: [hit, { junk: true }] },
          })
        )}
      />
    )
    const notes = container.querySelectorAll("[data-pa-mention]")
    expect(notes).toHaveLength(1)
    expect(notes[0].textContent).toBe(
      "You mentioned “release” — reminder: Update the Homebrew formula first"
    )
    // With what else the line under it says.
    expect(container.querySelector("[data-pa-state]")).toBeTruthy()
    cleanup()
    const none = draw(
      <OwnerBubble
        item={ownerItem(row(13, "owner", { body: "hi", status: "answered" }))}
      />
    )
    expect(none.container.querySelector("[data-pa-mention]")).toBeNull()
  })
})

describe("DispatchAttachments", () => {
  it("shows how the work stands, who runs it and what, and opens it", () => {
    pa.dispatchById = new Map([[5, dispatchInfo({ state: "review" })]])
    const { container } = draw(
      <DispatchAttachments
        rows={[
          row(20, "dispatch", {
            body: "Add a test page",
            dispatch_id: 5,
            data: { mode: "task", executor: "Builder", executor_id: 3 },
          }),
        ]}
      />
    )
    const pill = container.querySelector<HTMLElement>(
      "button[data-row-id='20']"
    )!
    expect(pill.hasAttribute("data-pa-work-pill")).toBe(true)
    expect(pill.querySelector("[title='In review'] svg")).not.toBeNull()
    expect(pill.textContent).toBe("BBuilder·Add a test pageIn review")
    expect(pill.textContent).not.toContain("Kanban task")
    fireEvent.click(pill)
    expect(usePersonalAgentUi.getState().work).toMatchObject({
      dispatchId: 5,
      mode: "task",
      workTaskId: 7,
    })
  })

  it("says how long running work has been going, a follow-up, and one never sent", () => {
    pa.dispatchById = new Map([
      [
        5,
        dispatchInfo({
          state: "running",
          updated_at: new Date(Date.now() - 125_000).toISOString(),
        }),
      ],
    ])
    const { container } = draw(
      <DispatchAttachments
        rows={[
          row(20, "dispatch", { body: "Add a test page", dispatch_id: 5 }),
          row(21, "dispatch", {
            body: "Add a test page",
            dispatch_id: 5,
            data: { followup: true, failed: true },
          }),
        ]}
      />
    )
    const [running, unsent] = Array.from(
      container.querySelectorAll<HTMLElement>("[data-pa-work-pill]")
    )
    expect(
      running.querySelector("[title='Running'] svg")?.getAttribute("class")
    ).toContain("motion-safe:animate-spin")
    expect(running.textContent).toMatch(/2m/)
    expect(unsent.querySelector("[title='Not sent'] svg")).not.toBeNull()
    expect(unsent.textContent).toContain("Continue: Add a test page")
    expect(unsent.textContent).not.toMatch(/2m/)
  })

  it("folds the work past three into one more pill", () => {
    pa.dispatchById = new Map()
    const rows = [30, 31, 32, 33, 34].map((id) =>
      row(id, "dispatch", {
        body: `Work ${id}`,
        data: { executor: "Builder", state: "queued" },
      })
    )
    const { container } = draw(<DispatchAttachments rows={rows} />)
    expect(container.querySelectorAll("[data-pa-work-pill]")).toHaveLength(3)
    fireEvent.click(screen.getByRole("button", { name: "2 more" }))
    expect(container.querySelectorAll("[data-pa-work-pill]")).toHaveLength(5)
  })
})

describe("the kind of work and why this executor (7.9)", () => {
  it("says what kind of work it is and why the assistant picked it, not on a follow-up", () => {
    pa.dispatchById = new Map()
    const { container } = draw(
      <DispatchAttachments
        rows={[
          row(20, "dispatch", {
            body: "Look into Y",
            data: {
              executor: "Researcher",
              state: "queued",
              kind: "research",
              why: "It passed 9 of 10 research jobs the first time.",
            },
          }),
          row(21, "dispatch", {
            body: "Look into Y",
            data: { followup: true, kind: "research", why: "again" },
          }),
          row(22, "dispatch", {
            body: "Something",
            data: { executor: "Builder", state: "queued", kind: "cooking" },
          }),
        ]}
      />
    )
    const lines = container.querySelectorAll("[data-pa-dispatch-why]")
    expect(lines).toHaveLength(1)
    expect(lines[0].textContent).toBe(
      "Research · Why: It passed 9 of 10 research jobs the first time."
    )
  })
})

describe("acceptance on the work handed out (7.5)", () => {
  it("shows the assistant's acceptance criteria under its pill", () => {
    pa.dispatchById = new Map([
      [
        5,
        dispatchInfo({
          state: "running",
          done_when: "1. no blank screen\n2. the tests pass",
        }),
      ],
    ])
    const { container } = draw(
      <DispatchAttachments
        rows={[
          row(20, "dispatch", { body: "Add a test page", dispatch_id: 5 }),
        ]}
      />
    )
    const criteria = container.querySelector("[data-pa-done-when]")!
    expect(criteria.textContent).toContain("Done when")
    expect(criteria.textContent).toContain("1. no blank screen")
    expect(criteria.textContent).toContain("2. the tests pass")
  })

  it("reads the criteria off the card before the page has the dispatch, and not on a follow-up", () => {
    pa.dispatchById = new Map()
    const { container } = draw(
      <DispatchAttachments
        rows={[
          row(20, "dispatch", {
            body: "Add a test page",
            data: {
              executor: "Builder",
              state: "queued",
              done_when: "It builds",
            },
          }),
          row(21, "dispatch", {
            body: "Add a test page",
            data: { followup: true, done_when: "It builds" },
          }),
        ]}
      />
    )
    expect(container.querySelectorAll("[data-pa-done-when]")).toHaveLength(1)
  })

  it("says a check is the acceptance check of a round, and whose executor config checks it", () => {
    pa.dispatchById = new Map()
    const { container } = draw(
      <DispatchAttachments
        rows={[
          row(20, "dispatch", {
            body: "Add a test page",
            data: {
              executor: "Checker",
              state: "running",
              check_for: 4,
              check_round: 2,
              check_via: { bot_id: 9, name: "Ace" },
            },
          }),
        ]}
      />
    )
    const label = container.querySelector("[data-pa-check-label]")!
    expect(label.textContent).toContain("Acceptance check · round 2")
    expect(label.textContent).toContain("checked with Ace's executor config")
    expect(container.querySelector("[data-pa-work-pill]")).toBeTruthy()
  })
})
