/**
 * "Is this right?" (10.3): the check's card in the primary's conversation.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { TimelineRow } from "@/lib/types"

const api = vi.hoisted(() => ({
  personalAgentNoticeAct: vi.fn(async (): Promise<unknown> => ({})),
  personalAgentTimelineRows: vi.fn(async (): Promise<unknown[]> => []),
  personalAgentBots: vi.fn(async () => []),
  personalAgentChecks: vi.fn(async () => []),
  personalAgentCheckMessage: vi.fn(),
}))
vi.mock("@/lib/api", () => api)
vi.mock("@/lib/platform", () => ({
  subscribe: () => Promise.resolve(() => {}),
  onTransportReconnect: () => () => {},
}))
const dispatches = vi.hoisted(() => ({ byId: new Map<number, unknown>() }))
vi.mock("@/contexts/personal-agent-context", () => ({
  useBotId: () => null,
  usePersonalAgent: () => ({ dispatchById: dispatches.byId }),
}))
const opened = vi.hoisted(() => vi.fn())
vi.mock("./session-link", () => ({
  useSessionLinkOpener: () => opened,
}))

import { CheckCard } from "./check-card"
import { buildMessageItems, type MessageItem } from "./message-items"
import { PageScopeContext, type PageScope } from "./shared"

function row(data: Record<string, unknown>): TimelineRow {
  return {
    id: 51,
    segment_id: 1,
    batch_id: null,
    kind: "notice",
    status: null,
    body: "Checked a message",
    data: {
      notice: "check",
      check_id: 3,
      conversation_id: 42,
      conversation_title: "Fix the build",
      message: "It builds. The tests pass.",
      asked: "Does it build?",
      quote: null,
      dispatch_id: 9,
      executor: "Claude checker",
      ...data,
    },
    dispatch_id: null,
    ref_id: "8",
    reply_to: null,
    read_at: null,
    event_id: null,
    seen_at: null,
    created_at: "2026-11-15T08:00:00Z",
    updated_at: "2026-11-15T08:00:00Z",
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

function item(r: TimelineRow) {
  const it = buildMessageItems([r]).find((i) => i.kind === "notice")
  if (!it) throw new Error("no notice item")
  return it as Extract<MessageItem, { kind: "notice" }>
}

function wrap(r: TimelineRow, readOnly = false) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PageScopeContext.Provider value={scope(readOnly)}>
        <CheckCard item={item(r)} />
      </PageScopeContext.Provider>
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  api.personalAgentNoticeAct.mockClear()
  opened.mockClear()
  dispatches.byId = new Map()
})
afterEach(() => cleanup())

describe("the check's card", () => {
  it("while checking, says who checks it and offers no check again yet", () => {
    dispatches.byId = new Map([[9, { id: 9, conversation_id: 77 }]])
    const { container } = wrap(row({ state: "checking" }))
    expect(
      container.querySelector("[data-pa-check-card='checking']")
    ).toBeTruthy()
    expect(
      screen.getByText("Checking a message in “Fix the build”")
    ).toBeTruthy()
    expect(screen.getByText("Checked by Claude checker")).toBeTruthy()
    expect(
      (screen.getByRole("button", { name: "Check again" }) as HTMLButtonElement)
        .disabled
    ).toBe(true)
    // Its work is under way: watch it.
    fireEvent.click(screen.getByRole("button", { name: "See the check" }))
    expect(opened).toHaveBeenCalledWith(77)
  })

  it("when done, shows the verdict, its evidence and what was checked", () => {
    const { container } = wrap(
      row({
        state: "done",
        verdict: "false",
        evidence: "- src/build.rs:3 still fails",
      })
    )
    expect(
      container.querySelector("[data-pa-check-verdict='false']")
    ).toBeTruthy()
    expect(
      screen.getByText("Checked a message in “Fix the build”: Not true")
    ).toBeTruthy()
    expect(screen.getByText("- src/build.rs:3 still fails")).toBeTruthy()
    expect(screen.getByText("It builds. The tests pass.")).toBeTruthy()
    expect(screen.getByText("It answered: Does it build?")).toBeTruthy()
    // No session known for its work: nothing to watch.
    expect(screen.queryByRole("button", { name: "See the check" })).toBeNull()
    fireEvent.click(
      screen.getByRole("button", { name: "Open the conversation" })
    )
    expect(opened).toHaveBeenCalledWith(42)
    fireEvent.click(screen.getByRole("button", { name: "Check again" }))
    expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(8, "recheck", null)
  })

  it("with no conversation to open, leads its row with a button that looks one", () => {
    wrap(row({ state: "done", verdict: "true", conversation_id: null }))
    expect(
      screen.queryByRole("button", { name: "Open the conversation" })
    ).toBeNull()
    expect(
      screen
        .getByRole("button", { name: "Check again" })
        .getAttribute("data-variant")
    ).toBe("outline")
  })

  it("for a sentence, shows the sentence first and the message on asking", () => {
    wrap(
      row({
        state: "done",
        verdict: "partly",
        evidence: "- 2 of 40 fail",
        quote: "The tests pass.",
        conversation_title: null,
      })
    )
    expect(
      screen.getByText("Checked a sentence in a conversation: Partly true")
    ).toBeTruthy()
    expect(screen.getByText("The tests pass.")).toBeTruthy()
    expect(screen.queryByText("It builds. The tests pass.")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Show all" }))
    expect(screen.getByText("It builds. The tests pass.")).toBeTruthy()
  })

  it("not finished, says why; a read-only page cannot check again", () => {
    wrap(
      row({ state: "failed", note: "failed:the agent would not start" }),
      true
    )
    expect(
      screen.getByText(
        "The check of a message in “Fix the build” did not finish"
      )
    ).toBeTruthy()
    expect(
      screen.getByText("It failed: the agent would not start")
    ).toBeTruthy()
    expect(
      (screen.getByRole("button", { name: "Check again" }) as HTMLButtonElement)
        .disabled
    ).toBe(true)
  })
})
