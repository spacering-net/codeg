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
  snapshot: null as unknown,
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
    snapshot: pa.snapshot,
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
import {
  AGENT_SURFACE,
  PageScopeContext,
  SHEET_ROW_HOVER,
  type PageScope,
} from "./shared"

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

/** What a piece of work runs on: the page's own assistant's work agent,
 *  Codex. */
const WORK: DispatchInfo["work"] = {
  name: "Aide",
  bot_uid: "u-aide",
  agent_type: "codex",
  agent_options: { config_values: {} },
  label_snapshot: null,
  instructions: "",
}

/** The dispatch the work cards point at: a task on the board, the
 *  assistant's own, run on Codex. */
function dispatchInfo(patch: Partial<DispatchInfo> = {}): DispatchInfo {
  return {
    id: 5,
    mode: "task",
    work: WORK,
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
  pa.snapshot = null
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
    const stop = screen.getByRole("button", { name: "Stop the reply" })
    // Under the bubble its square is filled (the status line's is hollow).
    expect(
      stop
        .querySelector("[data-pa-stop-icon]")!
        .getAttribute("data-pa-stop-icon")
    ).toBe("filled")
    expect(
      stop.querySelector("[data-pa-stop-icon]")!.getAttribute("class")
    ).toContain("fill-current")
    expect(stop.className).not.toContain("hover:text-destructive")
    fireEvent.click(stop)
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
    expect(bubble.className).toContain("max-w-full")
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

  it("draws a reply that is one card as the card, no bubble round it", () => {
    const spec =
      '```spec\n{"root":"a","elements":{"a":{"type":"Text","props":{"text":"Hi"}}}}\n```'
    const one = (
      id: number,
      body: string,
      data: Record<string, unknown> = {}
    ) =>
      itemOf(
        [
          row(id, "reply", {
            batch_id: id,
            body,
            data: { state: "done", ...data },
          }),
        ],
        "reply"
      ) as Extract<MessageItem, { kind: "reply" }>
    for (const body of [spec, spec.replace(/\n/g, "\r\n")]) {
      const { container, unmount } = draw(
        <ReplyBubble item={one(30, body, { brief: { kind: "brief" } })} />
      )
      const bubble = container.querySelector("[data-bubble]")!
      expect(bubble.hasAttribute("data-pa-bare")).toBe(true)
      expect(bubble.classList.contains("pa-agent-bubble")).toBe(false)
      // What it is of stays, a small line over the card.
      expect(
        container.querySelector("[data-pa-reply-brief='brief']")
      ).not.toBeNull()
      unmount()
    }
    // Words with it: a bubble as ever.
    const { container } = draw(
      <ReplyBubble item={one(31, `Here it is:\n\n${spec}`)} />
    )
    const bubble = container.querySelector("[data-bubble]")!
    expect(bubble.hasAttribute("data-pa-bare")).toBe(false)
    expect(bubble.classList.contains("pa-agent-bubble")).toBe(true)
  })

  it("draws a routine's report as a card: the routine and its run its header, all it says under it", () => {
    const report = (id: number, body: string) =>
      itemOf(
        [
          row(id, "reply", {
            batch_id: id,
            body,
            data: {
              state: "done",
              routine: { id: 5, title: "Night CI", seq: 2 },
            },
          }),
        ],
        "reply"
      ) as Extract<MessageItem, { kind: "reply" }>
    const { container, unmount } = draw(
      <ReplyBubble item={report(40, "All green.\n\nNothing to do.")} />
    )
    const card = container.querySelector<HTMLElement>(
      "[data-pa-reply-routine-card='5']"
    )!
    expect(card).not.toBeNull()
    expect(card.hasAttribute("data-pa-card-message")).toBe(true)
    expect(container.querySelector(".pa-agent-bubble")).toBeNull()
    // Its header the routine and which run, a band of its own.
    const head = card.querySelector<HTMLElement>("[data-pa-sheet-head]")!
    expect(head.textContent).toBe("Routine “Night CI” · run 2")
    expect(head.querySelector("[data-pa-reply-routine='5']")).not.toBeNull()
    // What it says under it, whole: its paragraphs no bubbles of their own.
    const body = card.querySelector<HTMLElement>("[data-pa-sheet-part]")!
    expect(body.textContent).toContain("All green.")
    expect(body.textContent).toContain("Nothing to do.")
    expect(container.querySelectorAll("[data-bubble]")).toHaveLength(1)
    expect(container.querySelector("[data-pa-bubble-part]")).toBeNull()
    unmount()
    // A report that is one card is that card, the small line over it.
    const spec =
      '```spec\n{"root":"a","elements":{"a":{"type":"Text","props":{"text":"Hi"}}}}\n```'
    const one = draw(<ReplyBubble item={report(41, spec)} />)
    expect(
      one.container.querySelector("[data-pa-reply-routine-card]")
    ).toBeNull()
    expect(
      one.container.querySelector("[data-bubble]")!.hasAttribute("data-pa-bare")
    ).toBe(true)
    expect(
      one.container.querySelector("[data-pa-reply-routine='5']")
    ).not.toBeNull()
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
    // Side by side in a column that fits each to its text, each is still no
    // wider than the frame: a line that does not wrap (a quote's title, a
    // long name in code) cannot widen one past the column.
    bubbles.forEach((b) => expect(b.className).toContain("max-w-full"))
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
        // A card of its own under the brief: its title a band across it,
        // centred, a hairline under it — as an assistant's card's title.
        const card = container.querySelector("[data-pa-brief-tidied]")!
        const title = card.querySelector("h4")!
        expect(title.className).toContain("py-3")
        expect(title.className).toContain("border-b")
        expect(card.className).toContain("overflow-hidden")
        expect(card.className).not.toContain("pt-4")
        // The band's hairline over the first row: none of the row's own.
        expect(card.className).toContain(
          "[&_[data-pa-tidy-line]:first-child]:border-t-0"
        )
      }
      unmount()
    }
  })

  it("names the memory a reply used, each opening its entry (7.7)", () => {
    usePersonalAgentUi.setState({ settings: null, botPage: null })
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
    expect(usePersonalAgentUi.getState().botPage).toEqual({
      tab: "persona",
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

  it("draws the work's row inside the card, led by how it runs, with no face beside the card or on it", () => {
    const item = itemOf(
      [
        row(6, "result", {
          body: "Build the page",
          data: {
            agent_type: "codex",
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
    // Only the assistant speaks: no avatar beside the card, none on it.
    expect(
      frame.querySelectorAll("[data-slot='assistant-avatar']")
    ).toHaveLength(0)
    const work = frame.querySelector("[data-pa-work]")!
    expect(frame.querySelector("[data-bubble]")!.contains(work)).toBe(true)
    // The row a reply's card is: how it runs (its glyph), the title over
    // what and where, how it stood — in the words the reply's card uses.
    expect(work.firstElementChild?.getAttribute("data-pa-work-glyph")).toBe(
      "task"
    )
    const [title, meta] = Array.from(work.children[1].children)
    expect(title.textContent).toBe("Build the page")
    expect(meta.textContent).toBe("Kanban task")
    expect(work.children[2].textContent).toBe("Done")
    // Unread until the assistant starts on it, beside the card.
    expect(frame.querySelector("[data-pa-aside]")?.textContent).toBe("Unread")
  })

  it("keeps a reply's work to a pill, and leaves where it runs and the rest to the news", () => {
    pa.dispatchById = new Map([[5, dispatchInfo({ state: "completed" })]])
    const reply = draw(
      <DispatchAttachments
        rows={[
          row(20, "dispatch", {
            body: "Add a test page",
            dispatch_id: 5,
            data: { mode: "task", agent_type: "codex" },
          }),
        ]}
      />
    )
    const pill = reply.container.querySelector<HTMLElement>(
      "[data-pa-work-pill]"
    )!
    // How it runs (its glyph — no face, no agent's mark) and what it is,
    // then how it stands as an icon (its word for a screen reader and a
    // pointer) — no kind or place, no one named on the assistant's own.
    const glyph = pill.querySelector<HTMLElement>("[data-pa-work-glyph]")!
    expect(glyph.getAttribute("data-pa-work-glyph")).toBe("task")
    expect(glyph.style.width).toBe("1.25rem")
    expect(pill.firstElementChild).toBe(glyph)
    expect(pill.querySelector("[data-slot='assistant-avatar']")).toBeNull()
    expect(pill.querySelector("[title='Done'] svg")).not.toBeNull()
    expect(pill.querySelector(".sr-only")?.textContent).toBe("Done")
    expect(pill.textContent).toBe("Add a test pageDone")
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
                  agent_type: "codex",
                  title: "Add a test page",
                  mode: "task",
                  state: "completed",
                  work_task_id: 7,
                  excerpt: "Added it.",
                  gist: "Added it.",
                },
              }),
            ],
            "event"
          ) as Extract<MessageItem, { kind: "event" }>
        }
      />
    )
    // The news says the rest: the kind of work and where, the state in a
    // chip — its result under that. Still no face, nor the agent it runs
    // on (a fact of the side panel's, not a speaker).
    const head = news.container.querySelector("[data-pa-work]")!
    expect(
      head
        .querySelector("[data-pa-work-glyph]")
        ?.getAttribute("data-pa-work-glyph")
    ).toBe("task")
    expect(head.querySelector("[data-slot='assistant-avatar']")).toBeNull()
    expect(head.textContent).toContain("Kanban task · my-app")
    expect(head.textContent).not.toContain("Codex")
    expect(head.textContent).not.toContain("Aide")
    expect(head.textContent).toContain("Done")
    // Done, and not a routine's: its menu makes it one (D1).
    expect(head.querySelector("[data-pa-work-menu]")).not.toBeNull()
    // On one card: the work its head, its result's gist under a hairline —
    // the whole of it, nothing more to open.
    const result = news.container.querySelector("[data-pa-result-text]")!
    expect(result.previousElementSibling).toBe(head)
    expect(head.parentElement?.hasAttribute("data-pa-surface")).toBe(true)
    expect(result.textContent).toBe("Added it.")
    expect(result.querySelector("[data-pa-show-text]")).toBeNull()
  })

  it("tints the assistant's side with no border, and draws what sits on it as a card of its own", () => {
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
                data: { agent_type: "codex", state: "running", mode: "task" },
              }),
            ],
            "event"
          ) as Extract<MessageItem, { kind: "event" }>
        }
      />
    )
    // The news is a card of its own, no bubble round it; the work its head,
    // no surface of its own.
    const sheet = container.querySelector<HTMLElement>("[data-bubble]")!
    expect(sheet.hasAttribute("data-pa-card-message")).toBe(true)
    expect(container.querySelector(".pa-agent-bubble")).toBeNull()
    const workRow = container.querySelector<HTMLElement>("[data-pa-work]")!
    expect(workRow.parentElement).toBe(sheet)
    expect(sheet.hasAttribute("data-pa-surface")).toBe(true)
    expect(sheet.className).toContain("bg-card")
    expect(sheet.className).toContain("overflow-hidden")
    expect(workRow.getAttribute("data-pa-work")).toBe("head")
    expect(workRow.className).not.toContain("bg-(--pa-object)")
    // The card's head: the faintest step under the pointer, not the wash
    // a thing on the card takes.
    expect(workRow.className).toContain(SHEET_ROW_HOVER)
    expect(workRow.className).not.toContain("hover:bg-(--pa-object-hover)")
    cleanup()
    const pills = draw(
      <DispatchAttachments
        rows={[
          row(20, "dispatch", {
            body: "Add a test page",
            dispatch_id: 5,
            data: { mode: "task", agent_type: "codex" },
          }),
        ]}
      />
    )
    const pill = pills.container.querySelector("[data-pa-work-pill]")!
    // A thing on the bubble: white with a hairline there, a wash on a card.
    expect(pill.className).toContain("bg-(--pa-object)")
    expect(pill.className).toContain("var(--pa-object-edge,transparent)")
    expect(pill.className).toContain("hover:bg-(--pa-object-hover)")
    expect(pill.className).toContain("active:bg-(--pa-object-active)")
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
    // The news is a card of its own: no bubble, no bubble's corners.
    expect(
      container
        .querySelector("[data-row-id='4'] [data-bubble]")!
        .hasAttribute("data-pa-card-message")
    ).toBe(true)
  })

  it("leads the work's row with how it runs, on a quiet disc — never a face or the agent's mark", () => {
    const card = (id: number, data: Record<string, unknown>) =>
      itemOf(
        [
          row(id, "result", {
            body: "Work",
            data: { agent_type: "codex", title: "Work", ...data },
          }),
        ],
        "event"
      ) as Extract<MessageItem, { kind: "event" }>
    for (const mode of ["task", "chat", "session"] as const) {
      const { container, unmount } = draw(
        <EventCard item={card(16, { mode })} />
      )
      const work = container.querySelector("[data-pa-work]")!
      const glyph = work.firstElementChild as HTMLElement
      expect(glyph.getAttribute("data-pa-work-glyph")).toBe(mode)
      // As tall as the row's two lines, in rem; out of the accessible
      // name, the line beside it says how it runs.
      expect(glyph.style.width).toBe("2rem")
      expect(glyph.style.height).toBe("2rem")
      expect(glyph.getAttribute("aria-hidden")).toBe("true")
      expect(glyph.querySelector("svg")).not.toBeNull()
      // The agent it ran on is recorded, and not drawn: no avatar, no mark.
      expect(work.querySelector("[data-slot='assistant-avatar']")).toBeNull()
      expect(work.querySelector("[data-pa-badged]")).toBeNull()
      expect(work.querySelector("[data-pa-agent-badge]")).toBeNull()
      expect(work.textContent).not.toContain("Codex")
      unmount()
    }
    // A kind the row never recorded: a glyph all the same.
    const bare = draw(<EventCard item={card(17, {})} />)
    const plain = bare.container.querySelector("[data-pa-work]")!
    expect(plain.firstElementChild?.getAttribute("data-pa-work-glyph")).toBe("")
    expect(plain.firstElementChild?.querySelector("svg")).not.toBeNull()
  })

  it("draws a card's result as markdown, not as its marks", () => {
    const item = itemOf(
      [
        row(10, "result", {
          body: "Build",
          data: {
            agent_type: "codex",
            title: "Run the build",
            excerpt: "## Build: ok\n\n**Exit code**: `0`\n\n- one\n- two",
          },
        }),
      ],
      "event"
    ) as Extract<MessageItem, { kind: "event" }>
    const { container } = draw(<EventCard item={item} />)
    const bubble = container.querySelector("[data-bubble]")!
    // Folded to its gist (none here), opened to the whole of it.
    expect(bubble.querySelector("h2")).toBeNull()
    fireEvent.click(bubble.querySelector("[data-pa-show-text]")!)
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
          work: WORK,
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
            title: "Research the topic",
            mode: "chat",
            state: "completed",
            conversation_id: 41,
            conversation_folder_id: 7,
            agent_type: "codex",
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
      // The assistant whose work it is, as it handed it out: the drawer
      // names it, the conversation never does.
      assistantName: "Aide",
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
          data: { agent_type: "codex", title: "Task", mode: "task" },
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
  it("shows how the work stands and what it is, whose when another's, and opens it", () => {
    pa.snapshot = { agent: { id: 1, uid: "u-aide", name: "Aide" } }
    pa.dispatchById = new Map([
      [5, dispatchInfo({ state: "review" })],
      [
        6,
        dispatchInfo({
          id: 6,
          state: "running",
          work: { ...WORK, name: "Scout", bot_uid: "u-scout" },
        }),
      ],
    ])
    const { container } = draw(
      <DispatchAttachments
        rows={[
          row(20, "dispatch", {
            body: "Add a test page",
            dispatch_id: 5,
            data: { mode: "task", agent_type: "codex" },
          }),
          row(22, "dispatch", {
            body: "Add a test page",
            dispatch_id: 6,
            data: { mode: "task", agent_type: "codex" },
          }),
        ]}
      />
    )
    const pill = container.querySelector<HTMLElement>(
      "button[data-row-id='20']"
    )!
    expect(pill.hasAttribute("data-pa-work-pill")).toBe(true)
    expect(pill.querySelector("[title='In review'] svg")).not.toBeNull()
    // The assistant's own work: no one named, nor the agent it runs on.
    expect(pill.textContent).toBe("Add a test pageIn review")
    expect(pill.textContent).not.toContain("Kanban task")
    // Work handed over to it: the assistant whose it is, before what it is.
    expect(
      container.querySelector<HTMLElement>("button[data-row-id='22']")!
        .textContent
    ).toMatch(/^Scout·Add a test page/)
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
        data: { agent_type: "codex", state: "queued" },
      })
    )
    const { container } = draw(<DispatchAttachments rows={rows} />)
    expect(container.querySelectorAll("[data-pa-work-pill]")).toHaveLength(3)
    fireEvent.click(screen.getByRole("button", { name: "2 more" }))
    expect(container.querySelectorAll("[data-pa-work-pill]")).toHaveLength(5)
  })
})

describe("no kind of work, no why this executor (R7)", () => {
  it("says neither under a pill, whatever an old card carries", () => {
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
        ]}
      />
    )
    expect(container.querySelector("[data-pa-work-pill]")).toBeTruthy()
    expect(container.textContent).not.toContain("research jobs")
    expect(container.textContent).not.toContain("Why")
    // Nor the executor config it once named: only the assistant speaks.
    expect(container.textContent).not.toContain("Researcher")
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
              agent_type: "codex",
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

  it("says a check is the acceptance check of a round, and names no one, whatever an old card carries", () => {
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
    expect(label.textContent).toBe("Acceptance check · round 2")
    expect(container.querySelector("[data-pa-work-pill]")).toBeTruthy()
    expect(container.textContent).not.toContain("Checker")
    expect(container.textContent).not.toContain("Ace")
  })
})

describe("a result card and the reply that reports it (A1, A2)", () => {
  afterEach(() => {
    cleanup()
    pa.snapshot = null
    usePersonalAgentUi.setState({ openResults: {} })
  })
  const card = (patch: Record<string, unknown> = {}, rowPatch = {}) =>
    row(30, "result", {
      body: "Analyse my-app",
      data: {
        agent_type: "codex",
        title: "Analyse my-app",
        mode: "session",
        state: "failed",
        note: "the model ran out of credit",
        excerpt: "## Overview\n\nmy-app is a demo. It uses the App Router.",
        gist: "my-app is a demo.",
        ...patch,
      },
      ...rowPatch,
    })
  const eventOf = (rows: TimelineRow[]) =>
    itemOf(rows, "event") as Extract<MessageItem, { kind: "event" }>

  it("says its gist and why it failed until a reply reports it, the whole a click away", () => {
    const { container } = draw(<EventCard item={eventOf([card()])} />)
    expect(container.querySelector("[data-pa-gist]")?.textContent).toBe(
      "my-app is a demo."
    )
    expect(container.textContent).toContain("the model ran out of credit")
    expect(container.querySelector("h2")).toBeNull()
    fireEvent.click(container.querySelector("[data-pa-show-text]")!)
    expect(container.querySelector("h2")?.textContent).toBe("Overview")
    expect(container.querySelector("[data-pa-gist]")).toBeNull()
  })

  it("folds its text and note away once reported, its head and buttons kept, opened as left after a remount", () => {
    pa.dispatchById = new Map()
    const rows = [
      card({}, { dispatch_id: null }),
      row(31, "reply", {
        batch_id: 9,
        body: "It failed for credit; top it up.",
        data: { state: "done", covers: [30] },
      }),
    ]
    const first = draw(<EventCard item={eventOf(rows)} />)
    const c = first.container
    expect(c.querySelector("[data-pa-work]")?.textContent).toContain(
      "Analyse my-app"
    )
    expect(c.querySelector("[data-pa-gist]")).toBeNull()
    expect(c.textContent).not.toContain("the model ran out of credit")
    const show = c.querySelector<HTMLButtonElement>("[data-pa-show-text]")!
    expect(show.getAttribute("aria-expanded")).toBe("false")
    fireEvent.click(show)
    expect(c.textContent).toContain("the model ran out of credit")
    expect(c.querySelector("h2")?.textContent).toBe("Overview")
    // The list unmounts it (scrolled away) and mounts it again.
    first.unmount()
    const again = draw(<EventCard item={eventOf(rows)} />)
    expect(again.container.querySelector("h2")?.textContent).toBe("Overview")
  })

  it("never cuts a gist that is all there is, and closes a note it opened", () => {
    const short = draw(
      <EventCard
        item={eventOf([card({ excerpt: "my-app is a demo.", note: null })])}
      />
    )
    const gist = short.container.querySelector("[data-pa-gist]")!
    expect(gist.className).not.toContain("line-clamp")
    expect(short.container.querySelector("[data-pa-show-text]")).toBeNull()
    cleanup()
    // Reported, with nothing but its note to open: opened, it closes again.
    const rows = [
      card({ excerpt: null, gist: null }),
      row(31, "reply", {
        batch_id: 9,
        body: "It ran out of credit.",
        data: { state: "done", covers: [30] },
      }),
    ]
    const { container } = draw(<EventCard item={eventOf(rows)} />)
    fireEvent.click(container.querySelector("[data-pa-show-text]")!)
    expect(container.textContent).toContain("the model ran out of credit")
    const hide = container.querySelector<HTMLButtonElement>(
      "[data-pa-show-text]"
    )!
    expect(hide.getAttribute("aria-expanded")).toBe("true")
    fireEvent.click(hide)
    expect(container.textContent).not.toContain("the model ran out of credit")
  })

  it("opens to the whole text, not a preview cut again", () => {
    const long = Array.from({ length: 40 }, (_, i) => `Line ${i}.`).join("\n\n")
    const { container } = draw(
      <EventCard item={eventOf([card({ excerpt: long, gist: "Line 0." })])} />
    )
    fireEvent.click(container.querySelector("[data-pa-show-text]")!)
    const whole = container.querySelector("[data-pa-result]")!
    expect(whole.className).not.toContain("max-h-")
    expect(whole.textContent).toContain("Line 39.")
  })

  it("leads a check's evidence until a reply reports it", () => {
    const check = card({
      check_for: 7,
      check_round: 1,
      verdict: "fail",
      evidence: "- a.txt:1 still says two",
      note: null,
    })
    const open = draw(<EventCard item={eventOf([check])} />)
    expect(open.container.textContent).toContain("a.txt:1 still says two")
    expect(open.container.querySelector("[data-pa-show-text]")).toBeNull()
    cleanup()
    const folded = draw(
      <EventCard
        item={eventOf([
          check,
          row(31, "reply", {
            batch_id: 9,
            body: "The check found a.txt wrong.",
            data: { state: "done", covers: [30] },
          }),
        ])}
      />
    )
    expect(folded.container.textContent).not.toContain("a.txt:1")
    expect(folded.container.querySelector("[data-pa-show-text]")).not.toBeNull()
  })

  it("draws no quote over it: the way to what it answers ends its head's line, a button of its own", () => {
    const jumpTo = vi.fn()
    const { container } = draw(
      <EventCard item={eventOf([card({}, { reply_to: 5 })])} />,
      { jumpTo }
    )
    // The card starts with the work: no quote over it.
    expect(
      container
        .querySelector("[data-bubble]")!
        .firstElementChild?.hasAttribute("data-pa-work")
    ).toBe(true)
    const source = container.querySelector<HTMLButtonElement>(
      "[data-pa-work] [data-pa-work-source]"
    )!
    expect(source.textContent).toBe("Source")
    expect(source.closest("button")).toBe(source)
    fireEvent.click(source)
    expect(jumpTo).toHaveBeenCalledWith(5)
    cleanup()
    // What it answers is the message right above: no way to it.
    const items = buildMessageItems([
      row(5, "reply", { batch_id: 2, body: "On it.", data: { state: "done" } }),
      card({}, { reply_to: 5 }),
    ])
    const news = items.find((i) => i.kind === "event") as Extract<
      MessageItem,
      { kind: "event" }
    >
    expect(news.quotesPrevious).toBe(true)
    const plain = draw(<EventCard item={news} />)
    expect(plain.container.querySelector("[data-pa-work-source]")).toBeNull()
  })

  it("draws the news of a merge as the work's head with its commit, its text a click away (A5)", () => {
    const { container } = draw(
      <EventCard
        item={eventOf([
          card({
            state: "completed",
            ladder: "merged",
            merge_commit: "a325330e1f",
            note: null,
            gist: "Updated the title.",
            excerpt: "Updated the title.\n\nAnd the test.",
          }),
        ])}
      />
    )
    expect(container.querySelector("[data-pa-work]")?.textContent).toContain(
      "Work session · a325330"
    )
    expect(container.textContent).not.toContain("a325330e1f")
    expect(container.querySelector("[data-pa-gist]")).toBeNull()
    expect(container.textContent).not.toContain("And the test.")
    fireEvent.click(container.querySelector("[data-pa-show-text]")!)
    expect(container.textContent).toContain("And the test.")
  })

  it("puts making it a routine in its head's menu, not a button under it (D1)", () => {
    pa.dispatchById = new Map([
      [
        40,
        dispatchInfo({
          id: 40,
          state: "completed",
          task: null,
          routine_id: null,
        } as Partial<DispatchInfo>),
      ],
    ])
    const { container } = draw(
      <EventCard
        item={eventOf([card({ state: "completed" }, { dispatch_id: 40 })])}
      />
    )
    expect(
      container.querySelector("[data-pa-work] [data-pa-work-menu]")
    ).not.toBeNull()
    expect(container.querySelector("[data-pa-event-actions]")).toBeNull()
    cleanup()
    // Read only: no menu.
    const read = draw(
      <EventCard
        item={eventOf([card({ state: "completed" }, { dispatch_id: 40 })])}
      />,
      { readOnly: true }
    )
    expect(read.container.querySelector("[data-pa-work-menu]")).toBeNull()
  })

  it("names no one on its own work — not the agent it ran on — and the assistant whose it is when handed over, told apart by uid", () => {
    pa.snapshot = { agent: { id: 2, uid: "u-aide", name: "Aide" } }
    const metaOf = (work: DispatchInfo["work"]) => {
      pa.dispatchById = new Map([
        [
          40,
          dispatchInfo({
            id: 40,
            mode: "session",
            state: "failed",
            work_task_id: null,
            task: null,
            work,
          } as Partial<DispatchInfo>),
        ],
      ])
      const { container, unmount } = draw(
        <EventCard item={eventOf([card({}, { dispatch_id: 40 })])} />
      )
      const head = container.querySelector("[data-pa-work]")!
      const line = head.children[1].children[1].textContent
      unmount()
      return line
    }
    // Its own work: how it runs and where, no name.
    expect(metaOf(WORK)).toBe("Work session · my-app")
    // Renamed since: still its own, by its uid.
    expect(metaOf({ ...WORK, name: "Old name" })).toBe("Work session · my-app")
    // Another assistant's work, handed over — even one of the same name.
    expect(metaOf({ ...WORK, name: "Scout", bot_uid: "u-scout" })).toBe(
      "Scout · Work session · my-app"
    )
    expect(metaOf({ ...WORK, bot_uid: "u-other" })).toBe(
      "Aide · Work session · my-app"
    )
  })
})
