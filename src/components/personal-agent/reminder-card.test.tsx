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
import type { TimelineRow } from "@/lib/types"

const api = vi.hoisted(() => ({ personalAgentNoticeAct: vi.fn() }))
vi.mock("@/lib/api", () => api)
vi.mock("@/contexts/personal-agent-context", () => ({
  useBotId: () => 7,
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

import { waitsForOwner } from "./message-list"
import { buildMessageItems, type MessageItem } from "./message-items"
import { NoticeCard } from "./notice-card"
import { PageScopeContext, type PageScope } from "./shared"

function card(data: Record<string, unknown>): TimelineRow {
  return {
    id: 40,
    segment_id: 1,
    batch_id: null,
    kind: "notice",
    status: null,
    body: "Reminder #7: Call the bank (due 15:00 Wed)",
    data: {
      notice: "reminder",
      state: "open",
      item_id: 7,
      summary: "Call the bank",
      at_due: "notify",
      due_at: new Date(Date.now() - 60_000).toISOString(),
      late_secs: 0,
      missed: 0,
      repeat: null,
      ...data,
    },
    dispatch_id: null,
    ref_id: "12",
    reply_to: null,
    read_at: null,
    event_id: null,
    seen_at: null,
    created_at: "2026-11-11T07:00:00Z",
    updated_at: "2026-11-11T07:00:00Z",
  }
}

function scope(readOnly = false): PageScope {
  return {
    readOnly,
    agentName: "Aide",
    liveRowId: null,
    connectionId: null,
    agentType: null,
    onQuote: vi.fn(),
    jumpTo: vi.fn(),
    rowsById: new Map(),
  }
}

function draw(row: TimelineRow, readOnly = false) {
  const item = buildMessageItems([row]).find((i) => i.kind === "notice")
  if (!item) throw new Error("no notice item")
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PageScopeContext.Provider value={scope(readOnly)}>
        <NoticeCard item={item as Extract<MessageItem, { kind: "notice" }>} />
      </PageScopeContext.Provider>
    </NextIntlClientProvider>
  )
}

afterEach(() => {
  cleanup()
  api.personalAgentNoticeAct.mockReset()
})

describe("a reminder card", () => {
  it("is a card of its own, its ending on its tone where its buttons were", () => {
    const open = draw(card({}))
    const sheet = open.container.querySelector("[data-pa-card-message]")!
    expect(sheet.getAttribute("data-pa-reminder")).toBe("notify")
    expect(sheet.closest(".pa-agent-bubble")).toBeNull()
    expect(sheet.querySelector("[data-pa-sheet-actions]")).not.toBeNull()
    open.unmount()
    const put = draw(
      card({
        state: "snoozed",
        until: new Date(Date.now() + 3600_000).toISOString(),
      })
    )
    const line = put.container.querySelector("[data-pa-reminder-state]")!
    expect(line.getAttribute("data-pa-outcome")).toBe("later")
    expect(put.container.querySelector("[data-pa-sheet-actions]")).toBeNull()
  })

  it("shows the matter and answers each button as it says", async () => {
    api.personalAgentNoticeAct.mockResolvedValue(card({ state: "done" }))
    draw(card({}))
    expect(screen.getByText("Reminder")).toBeTruthy()
    expect(screen.getByText("Call the bank")).toBeTruthy()
    // Not the brain's English line.
    expect(screen.queryByText(/Reminder #7/)).toBeNull()
    // Its buttons on the card's last band, under a hairline.
    expect(
      screen
        .getByRole("button", { name: "Done" })
        .closest("[data-pa-sheet-actions]")
    ).not.toBeNull()
    for (const [name, action] of [
      ["Done", "done"],
      ["In 15 min", "snooze:15m"],
      ["In 1 hour", "snooze:1h"],
      ["Tomorrow morning", "snooze:tomorrow"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name }))
      await waitFor(() =>
        expect(api.personalAgentNoticeAct).toHaveBeenLastCalledWith(
          12,
          action,
          7,
          undefined
        )
      )
    }
  })

  it("hands it to the assistant in the owner's words", async () => {
    api.personalAgentNoticeAct.mockResolvedValue(card({ state: "handed" }))
    draw(card({}))
    fireEvent.click(screen.getByRole("button", { name: "Hand to Aide" }))
    // The owner's words name no ledger number: the quoted card says which.
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(
        12,
        "hand_over",
        7,
        "Please handle this reminder: Call the bank"
      )
    )
  })

  it("says how late it came and what it skipped", () => {
    draw(
      card({
        late_secs: 2 * 3600,
        missed: 3,
        repeat: { every: "weekdays", at: "09:00" },
      })
    )
    expect(screen.getByText("2 h late")).toBeTruthy()
    expect(screen.getByText("Missed 3 times")).toBeTruthy()
    expect(screen.getByText("Every weekday 09:00")).toBeTruthy()
  })

  it("is not late when it came on time", () => {
    draw(card({ late_secs: 0 }))
    expect(screen.queryByText(/late$/)).toBeNull()
  })

  it("gives the buttons way to how it ended", () => {
    const until = new Date(Date.now() + 3_600_000).toISOString()
    draw(card({ state: "snoozed", until }))
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull()
    expect(screen.getByText(/^Put off until /)).toBeTruthy()
    cleanup()
    draw(card({ state: "expired" }))
    expect(screen.getByText("Expired — it came round again")).toBeTruthy()
  })

  it("has no buttons when the assistant was woken to do it", () => {
    draw(card({ at_due: "act", state: "woke" }))
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull()
    expect(
      screen.getByText("Time's up — the assistant was woken to do it")
    ).toBeTruthy()
  })

  it("cannot be answered on a read-only page", () => {
    draw(card({}), true)
    expect(screen.getByRole("button", { name: "Done" })).toBeDisabled()
  })

  it("shows why an answer did not go through", async () => {
    api.personalAgentNoticeAct.mockRejectedValue(new Error("gone"))
    draw(card({}))
    fireEvent.click(screen.getByRole("button", { name: "Done" }))
    expect(await screen.findByRole("alert")).toBeTruthy()
  })

  it("waits for the owner while open, unless it is the assistant's to do", () => {
    expect(waitsForOwner(card({}))).toBe(true)
    expect(waitsForOwner(card({ state: "done" }))).toBe(false)
    expect(waitsForOwner(card({ at_due: "act", state: "open" }))).toBe(false)
  })
})
