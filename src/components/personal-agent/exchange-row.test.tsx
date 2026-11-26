import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { ThreadView, TimelineRow } from "@/lib/types"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

const api = vi.hoisted(() => ({
  personalAgentThread: vi.fn(),
  personalAgentAnswerQuestion: vi.fn(),
  personalAgentRespondPermission: vi.fn(),
}))
vi.mock("@/lib/api", () => api)
vi.mock("@/contexts/personal-agent-context", () => ({
  useBotId: () => null,
  usePersonalAgent: () => ({
    liveReplies: new Map(),
    dispatchById: new Map(),
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

import { ExchangeRow } from "./exchange-row"
import { buildMessageItems, type MessageItem } from "./message-items"
import { MessageEnterContext, MessageRow } from "./message-row"
import { MirrorCard } from "./mirror-card"
import { PageScopeContext, type PageScope } from "./shared"

const primary = { id: 1, name: "Aide", avatar: null, kind: "primary" as const }
const dev = { id: 2, name: "Dev", avatar: null, kind: "worker" as const }

function line(
  id: number,
  direction: "out" | "in",
  peer = dev,
  extra: Record<string, unknown> = {}
): TimelineRow {
  return {
    id,
    segment_id: 1,
    batch_id: null,
    kind: "exchange",
    status: null,
    body: "Fix the cold-start white screen.\nDetails follow.",
    data: {
      direction,
      peer,
      message_id: 40 + id,
      thread_id: 41,
      from_bot_id: direction === "out" ? 1 : peer.id,
      to_bot_id: direction === "out" ? peer.id : 1,
      state: "queued",
      ...extra,
    },
    dispatch_id: null,
    ref_id: `m${40 + id}`,
    reply_to: null,
    read_at: null,
    event_id: null,
    seen_at: null,
    created_at: "2026-11-10T10:00:00Z",
    updated_at: "2026-11-10T10:00:00Z",
  }
}

function scope(): PageScope {
  return {
    readOnly: false,
    agentName: "Aide",
    liveRowId: null,
    connectionId: null,
    agentType: null,
    onQuote: vi.fn(),
    jumpTo: vi.fn(),
    rowsById: new Map(),
  }
}

function draw(rows: TimelineRow[]) {
  const items = buildMessageItems(rows)
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PageScopeContext.Provider value={scope()}>
        {items.map((item) =>
          item.kind === "exchange" ? (
            <ExchangeRow key={item.key} item={item} />
          ) : item.kind === "mirror" ? (
            <MirrorCard
              key={item.key}
              item={item as Extract<MessageItem, { kind: "mirror" }>}
            />
          ) : null
        )}
      </PageScopeContext.Provider>
    </NextIntlClientProvider>
  )
}

afterEach(() => {
  cleanup()
  for (const f of Object.values(api)) f.mockReset()
})

describe("ExchangeRow", () => {
  it("names who a message went to, never its words", () => {
    draw([line(1, "out")])
    const button = screen.getByRole("button", { name: /Sent a message to/ })
    expect(button.textContent).toContain("Dev")
    // Not on hover either (P6.3 2): what assistants say to each other is
    // read in the exchange.
    expect(button.getAttribute("title")).toBeNull()
    expect(document.body.textContent).not.toContain("cold-start")
    // Words and the peer's face, no arrow in front of them.
    const arrows = '[class*="lucide-arrow"]'
    expect(button.querySelectorAll(arrows)).toHaveLength(0)
    cleanup()
    draw([line(2, "in")])
    expect(
      screen
        .getByRole("button", { name: /Message from/ })
        .querySelectorAll(arrows)
    ).toHaveLength(0)
  })

  it("rises into place on its own element, so the list's spacing still sees its neighbours", () => {
    const [item] = buildMessageItems([line(1, "out")]).filter(
      (i) => i.kind === "exchange"
    ) as Extract<MessageItem, { kind: "exchange" }>[]
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <PageScopeContext.Provider value={scope()}>
          <div data-list>
            <MessageRow rowId={9} side="start" gap="side" tail>
              <div data-bubble>before</div>
            </MessageRow>
            <MessageEnterContext.Provider value>
              <ExchangeRow item={item} />
            </MessageEnterContext.Provider>
            <MessageEnterContext.Provider value>
              <MessageRow rowId={10} side="start" gap="side" tail>
                <div data-bubble>after</div>
              </MessageRow>
            </MessageEnterContext.Provider>
          </div>
        </PageScopeContext.Provider>
      </NextIntlClientProvider>
    )
    const list = container.querySelector("[data-list]")!
    const [before, exchange, after] = Array.from(list.children)
    // No wrapper: the line is the list's own child, right after the message
    // over it (so it keeps its room over it, `first:pt-0` not applying), and
    // the message under it is its next sibling (so `[data-pa-divider]+&`
    // starts it right there, not 32px down).
    expect(exchange.hasAttribute("data-pa-exchange")).toBe(true)
    expect(exchange.className).toContain("motion-message-enter")
    expect(exchange.previousElementSibling).toBe(before)
    expect(after.getAttribute("data-row-id")).toBe("10")
    expect(after.className).toContain("motion-message-enter")
    expect(after.previousElementSibling?.hasAttribute("data-pa-divider")).toBe(
      true
    )
    // What was there already does not rise.
    expect(before.className).not.toContain("motion-message-enter")
  })

  it("draws a run as one line that opens to each", () => {
    const review = {
      id: 3,
      name: "Review",
      avatar: null,
      kind: "worker" as const,
    }
    draw([line(1, "in"), line(2, "in", review)])
    const run = screen.getByRole("button", {
      name: /Exchanged 2 messages with Dev and Review/,
    })
    expect(screen.queryByRole("button", { name: /Message from/ })).toBeNull()
    fireEvent.click(run)
    expect(
      screen.getAllByRole("button", { name: /Message from/ })
    ).toHaveLength(2)
  })

  it("calls an unnamed primary by its role", () => {
    draw([
      line(1, "in", {
        id: 1,
        name: "",
        avatar: null,
        kind: "primary" as const,
      } as never),
    ])
    const button = screen.getByRole("button", { name: /Message from/ })
    expect(button.textContent).toContain("Personal agent")
  })

  it("says a message was taken back", () => {
    draw([line(1, "out", dev, { state: "stopped" })])
    expect(screen.getByText(/taken back/)).toBeTruthy()
  })

  it("opens the exchange with both sides' words", async () => {
    const view: ThreadView = {
      id: 41,
      state: "open",
      bots: [primary, dev],
      messages: [
        {
          id: 41,
          from_bot_id: 1,
          to_bot_id: 2,
          body: "Fix it, please.",
          reply_to: null,
          wants_reply: true,
          state: "replied",
          created_at: "2026-11-10T10:00:00Z",
        },
        {
          id: 42,
          from_bot_id: 2,
          to_bot_id: 1,
          body: "Done: PR #12.",
          reply_to: 41,
          wants_reply: false,
          state: "delivered",
          created_at: "2026-11-10T10:05:00Z",
        },
      ],
      dispatches: [
        {
          id: 9,
          bot_id: 2,
          title: "Fix the white screen",
          mode: "task",
          state: "completed",
          work_task_id: 3,
          conversation_id: null,
          conversation_folder_id: null,
          agent_type: "codex",
          created_at: "2026-11-10T10:01:00Z",
        },
      ],
    }
    api.personalAgentThread.mockResolvedValue(view)
    draw([line(1, "out")])
    fireEvent.click(screen.getByRole("button", { name: /Sent a message to/ }))
    await waitFor(() => expect(screen.getByText("Done: PR #12.")).toBeTruthy())
    expect(api.personalAgentThread).toHaveBeenCalledWith(41, null)
    expect(screen.getByText("Aide ⇄ Dev")).toBeTruthy()
    expect(screen.getByText("Fix it, please.")).toBeTruthy()
    expect(screen.getByText("Fix the white screen")).toBeTruthy()
    // The line's own message, marked (it is on this exchange).
    expect(
      document
        .querySelector("[data-pa-thread-target]")
        ?.getAttribute("data-pa-thread-message")
    ).toBe("41")
    // Dev's own work, which this page does not hold, opens all the same —
    // the bubble closed on its way.
    const pill = screen.getByText("Fix the white screen").closest("button")!
    expect(pill.disabled).toBe(false)
    fireEvent.click(pill)
    const ui = usePersonalAgentUi.getState()
    expect(ui.workOpen).toBe(true)
    expect(ui.work?.workTaskId).toBe(3)
    await waitFor(() => expect(screen.queryByText("Aide ⇄ Dev")).toBeNull())
    // [Open Dev's conversation]: Dev's page, the bubble closed.
    fireEvent.click(screen.getByRole("button", { name: /Sent a message to/ }))
    await waitFor(() => expect(screen.getByText("Aide ⇄ Dev")).toBeTruthy())
    // (jsdom lays nothing out: the bubble counts as scrolled out of sight,
    // hidden from roles.)
    fireEvent.click(
      screen.getByText("Open Dev's conversation").closest("button")!
    )
    expect(usePersonalAgentUi.getState().viewBot).toBe(2)
    await waitFor(() => expect(screen.queryByText("Aide ⇄ Dev")).toBeNull())
  })
})

describe("MirrorCard", () => {
  function mirror(
    state: string,
    kind: "question" | "permission" = "question"
  ): TimelineRow {
    return {
      ...line(5, "in"),
      kind,
      ref_id: "q-1",
      body: "Which branch?",
      data: {
        kind: "ask",
        state,
        questions: [
          {
            id: "a",
            question: "Which branch?",
            header: "Branch",
            multiSelect: false,
            options: [
              { label: "main", description: "" },
              { label: "dev", description: "" },
            ],
          },
        ],
        mirror_of: { bot_id: 2, row_id: 77 },
        from_bot: dev,
      },
    }
  }

  it("names who asks, and answers through this page", () => {
    draw([mirror("pending")])
    expect(screen.getByText("Dev asks you")).toBeTruthy()
    expect(screen.getAllByText("Which branch?").length).toBeGreaterThan(0)
  })

  it("says once it is answered, in either place", () => {
    draw([mirror("answered")])
    expect(screen.getByText("Answered")).toBeTruthy()
    // On a band of its card's sheet.
    expect(
      screen.getByText("Answered").closest("[data-pa-sheet-part]")
    ).not.toBeNull()
    // Settled: a line on its tone, where an answer was asked for.
    expect(
      screen.getByText("Answered").closest("[data-pa-mirror-settled]")
    ).not.toBeNull()
    // A card of its own: no bubble round it.
    const card = screen.getByText("Answered").closest("[data-pa-card-message]")!
    expect(card).not.toBeNull()
    expect(card.closest(".pa-agent-bubble")).toBeNull()
  })
})
