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
      agent_type: "claude_code",
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
  it("while checking, names no checker and offers no check again yet", () => {
    dispatches.byId = new Map([[9, { id: 9, conversation_id: 77 }]])
    const { container } = wrap(row({ state: "checking" }))
    expect(
      container.querySelector("[data-pa-check-card='checking']")
    ).toBeTruthy()
    expect(
      screen.getByText("Checking a message in “Fix the build”")
    ).toBeTruthy()
    // Only the assistant speaks: the check runs on its own work agent,
    // unnamed.
    expect(screen.queryByText(/Checked by/)).toBeNull()
    expect(container.querySelector("[data-pa-check-note]")).toBeNull()
    expect(
      (screen.getByRole("button", { name: "Check again" }) as HTMLButtonElement)
        .disabled
    ).toBe(true)
    // Its work is under way: watch it.
    fireEvent.click(screen.getByRole("button", { name: "See the check" }))
    expect(opened).toHaveBeenCalledWith(77)
  })

  it("keeps a title's own colon, and evidence as written", () => {
    const { container } = wrap(
      row({
        state: "done",
        verdict: "true",
        conversation_title: "Build: Fix Linux jobs",
        evidence: "Reproduced in <TaskStrip> (src/work.tsx:20), *not* bold.",
      })
    )
    // The verdict comes off the line's end, not at the title's colon.
    expect(container.querySelector("[data-pa-check-line]")?.textContent).toBe(
      "Checked a message in “Build: Fix Linux jobs”"
    )
    expect(
      container.querySelector("[data-pa-check-evidence]")?.textContent
    ).toBe("Reproduced in <TaskStrip> (src/work.tsx:20), *not* bold.")
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
      screen.getByText("Checked a message in “Fix the build”")
    ).toBeTruthy()
    // The verdict said once, on its chip at the title's end.
    expect(
      container.querySelector("[data-pa-check-chip='false']")?.textContent
    ).toBe("Not true")
    // The evidence as written.
    expect(
      container.querySelector("[data-pa-check-evidence]")?.textContent
    ).toBe("- src/build.rs:3 still fails")
    expect(screen.getByText("It builds. The tests pass.")).toBeTruthy()
    // What it answered, a fact: its label, then the question.
    const asked = container.querySelector("[data-pa-check-asked]")!
    expect(asked.querySelector("dt")?.textContent).toBe("It answered")
    expect(asked.querySelector("dd")?.textContent).toBe("Does it build?")
    // In bands, no box in a box: what it found, what it checked, its
    // evidence, its buttons.
    // A card of its own: its heading the first line, no bubble round it.
    const sheet = container.querySelector("[data-pa-surface]")!
    expect(sheet.hasAttribute("data-pa-card-message")).toBe(true)
    expect(sheet.closest(".pa-agent-bubble")).toBeNull()
    expect(sheet.children[0].hasAttribute("data-pa-sheet-head")).toBe(true)
    const parts = [...sheet.children].slice(1)
    expect(parts).toHaveLength(4)
    expect(
      parts[2].contains(screen.getByText("- src/build.rs:3 still fails"))
    ).toBe(true)
    expect(parts[3].hasAttribute("data-pa-sheet-actions")).toBe(true)
    expect(sheet.querySelector("[data-pa-sheet-part] .rounded-md")).toBeNull()
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
    ).toBe("secondary")
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
      screen.getByText("Checked a sentence in a conversation")
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
