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

import { buildMessageItems, type MessageItem } from "./message-items"
import { NoticeCard } from "./notice-card"
import { PageScopeContext, type PageScope } from "./shared"

function card(data: Record<string, unknown>): TimelineRow {
  return {
    id: 30,
    segment_id: 1,
    batch_id: 9,
    kind: "notice",
    status: null,
    body: "Research X",
    data: {
      notice: "proposal",
      action: "dispatch",
      display: {
        executor: "Researcher",
        executor_id: 3,
        agent_type: "codex",
        mode: "chat",
        project: null,
        title: "Research X",
        prompt: "Find out X.",
      },
      ...data,
    },
    dispatch_id: null,
    ref_id: "4",
    reply_to: null,
    read_at: null,
    event_id: null,
    seen_at: null,
    created_at: "2026-11-07T10:00:00Z",
    updated_at: "2026-11-07T10:00:00Z",
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

describe("NoticeCard", () => {
  it("shows the whole proposal and answers it as the card says", async () => {
    api.personalAgentNoticeAct.mockResolvedValue(card({ state: "acted" }))
    draw(card({ state: "open" }))
    expect(screen.getByText("Proposal · waiting for you")).toBeTruthy()
    expect(screen.getByText("Research X")).toBeTruthy()
    expect(screen.getByText("Researcher · Chat")).toBeTruthy()
    expect(screen.getByText("Find out X.")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Do this" }))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(4, "accept")
    )
  })

  it("says how it was answered, with nothing left to click", () => {
    draw(card({ state: "dismissed" }))
    expect(screen.getByText("Not taken up")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Do this" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Not now" })).toBeNull()
  })

  it("shows why an approval could not run, and the answer error", async () => {
    api.personalAgentNoticeAct.mockRejectedValue(
      new Error("assistant #3 is not an enabled role assistant")
    )
    draw(card({ state: "open" }))
    fireEvent.click(screen.getByRole("button", { name: "Do this" }))
    expect((await screen.findByRole("alert")).textContent).toContain(
      "not an enabled role assistant"
    )
  })

  it("reads running while what it runs is on its way, with nothing to click", () => {
    draw(card({ state: "acting" }))
    expect(screen.getByText("Running…")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Do this" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Not now" })).toBeNull()
  })

  it("offers to run it again when it is not sure it ran", async () => {
    api.personalAgentNoticeAct.mockResolvedValue(card({ state: "acting" }))
    draw(card({ state: "unknown" }))
    expect(screen.getByText("Not sure it ran")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Run again" }))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(4, "accept")
    )
  })

  it("asks about a step it cannot tell went through, and closes once it did", async () => {
    const uncertain = (state: string) =>
      card({
        notice: "uncertain",
        action: "followup",
        state,
        display: {
          dispatch_id: 12,
          executor: "Researcher",
          executor_id: 3,
          agent_type: "codex",
          mode: "session",
          conversation_id: 40,
          folder_id: 2,
          title: "Investigate",
          message: "and the tests",
        },
      })
    api.personalAgentNoticeAct.mockResolvedValue(uncertain("acting"))
    const { unmount } = draw(uncertain("open"))
    expect(screen.getByText("Not sure this went through")).toBeTruthy()
    expect(screen.getByText("Continue “Investigate”")).toBeTruthy()
    expect(screen.getByText("and the tests")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Look" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Send again" }))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(4, "accept")
    )
    unmount()
    // Sent again and cut off again: still not sure, still answerable.
    const again = draw(uncertain("unknown"))
    expect(screen.getByText("Not sure this went through")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Send again" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Let it be" })).toBeTruthy()
    again.unmount()
    draw(uncertain("resolved"))
    expect(screen.getByText("It did go through")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Send again" })).toBeNull()
  })

  it("is read-only where the engine runs elsewhere", () => {
    draw(card({ state: "open" }), true)
    const accept = screen.getByRole("button", { name: "Do this" })
    expect((accept as HTMLButtonElement).disabled).toBe(true)
  })
})
