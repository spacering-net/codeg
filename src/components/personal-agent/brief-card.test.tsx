/**
 * The morning brief codeg wrote itself (6.4): its parts from the materials,
 * each row opening what it is about.
 */
import { cleanup, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { BriefMaterial, TimelineRow, TodayRow } from "@/lib/types"

const api = vi.hoisted(() => ({
  personalAgentBots: vi.fn(async () => []),
}))
vi.mock("@/lib/api", () => api)
vi.mock("@/lib/platform", () => ({
  subscribe: () => Promise.resolve(() => {}),
  onTransportReconnect: () => () => {},
}))
vi.mock("@/contexts/tasks-view-context", () => ({
  useOptionalTasksView: () => null,
  useTasksView: () => ({ tasks: [], refetch: vi.fn() }),
}))
vi.mock("./session-link", () => ({
  useSessionLinkOpener: () => vi.fn(),
}))
vi.mock("@/stores/personal-agent-today-store", () => ({
  refreshToday: vi.fn(),
}))

import { __resetRosterForTests } from "@/stores/personal-agent-roster-store"

import { BriefCard } from "./brief-card"
import { buildMessageItems, type MessageItem } from "./message-items"
import { PageScopeContext, type PageScope } from "./shared"

function need(patch: Partial<TodayRow>): TodayRow {
  return {
    key: "failed:3",
    kind: "failed",
    bot_id: null,
    project: null,
    title: "Windows build",
    text: "link error",
    at: "2026-11-12T23:00:00Z",
    state: "failed",
    row_id: null,
    dispatch_id: null,
    task_id: null,
    conversation_id: null,
    item_id: null,
    notice_id: null,
    agent_type: null,
    undo: false,
    ...patch,
  }
}

function material(patch: Partial<BriefMaterial> = {}): BriefMaterial {
  return {
    kind: "brief",
    day: "2026-11-13",
    since: "2026-11-12T01:00:00Z",
    at: "2026-11-13T01:00:00Z",
    needs: [need({})],
    night: [],
    tonight: [],
    schedule: [],
    running: [],
    bots: [
      {
        bot_id: 2,
        name: "Dev",
        done: 2,
        done_titles: ["Bump deps", "Fix lint"],
        doing: [],
        stuck: 1,
        stuck_text: "Windows build",
      },
    ],
    loose: [
      {
        kind: "item",
        id: 9,
        bot_id: 2,
        title: "Look at the flaky test",
        project: null,
        since: "2026-11-04T01:00:00Z",
      },
    ],
    yesterday: {
      date: "2026-11-12",
      total: 5,
      by_project: [["codeg", 3]],
      by_agent: [["codex", 5]],
    },
    hours: null,
    suggestions: 3,
    dispatches: [],
    ...patch,
  }
}

function card(m: BriefMaterial): TimelineRow {
  return {
    id: 30,
    segment_id: 1,
    batch_id: null,
    kind: "notice",
    status: null,
    body: "Morning brief — 1 waiting on you",
    data: { notice: "brief", state: "open", material: m },
    dispatch_id: null,
    ref_id: "4",
    reply_to: null,
    read_at: null,
    event_id: null,
    seen_at: null,
    created_at: "2026-11-13T01:00:00Z",
    updated_at: "2026-11-13T01:00:00Z",
  }
}

const scope: PageScope = {
  readOnly: false,
  agentName: "Aide",
  liveRowId: null,
  connectionId: null,
  agentType: null,
  onQuote: vi.fn(),
  jumpTo: vi.fn(),
  rowsById: new Map(),
}

function draw(row: TimelineRow) {
  const item = buildMessageItems([row]).find((i) => i.kind === "notice")
  if (!item) throw new Error("no notice item")
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PageScopeContext.Provider value={scope}>
        <BriefCard item={item as Extract<MessageItem, { kind: "notice" }>} />
      </PageScopeContext.Provider>
    </NextIntlClientProvider>
  )
}

beforeEach(() => __resetRosterForTests())
afterEach(() => cleanup())

describe("the brief codeg wrote itself", () => {
  it("draws its parts from the materials", () => {
    const { container } = draw(card(material()))
    expect(screen.getByText("Morning brief")).toBeTruthy()
    expect(
      screen.getByText(
        "codeg wrote this from its records — the assistant couldn't write it."
      )
    ).toBeTruthy()
    expect(screen.getByText("Needs you")).toBeTruthy()
    expect(screen.getByText("Windows build")).toBeTruthy()
    const bot = container.querySelector("[data-pa-brief-bot='2']")
    expect(bot?.textContent).toBe(
      "Dev — finished 2 (Bump deps; Fix lint) · 1 waiting on you"
    )
    const loose = container.querySelector("[data-pa-brief-loose='item']")
    expect(loose?.textContent).toBe(
      "Look at the flaky test — untouched for 9 days"
    )
    expect(screen.getByText("5 sessions · codeg 3")).toBeTruthy()
    expect(container.querySelector("[data-pa-brief-part='night']")).toBe(null)
  })

  it("says what a message sent tonight got back", () => {
    const { container } = draw(
      card(
        material({
          tonight_messages: [
            {
              id: 12,
              to_bot_id: 2,
              to_name: "Ops",
              text: "Retry the build tonight",
              state: "replied",
              reply: "Retried: all green",
              at: "2026-11-13T00:00:00Z",
            },
          ],
        })
      )
    )
    const line = container.querySelector("[data-pa-brief-message='12']")
    expect(line?.textContent).toBe(
      "To Ops: Retry the build tonight — answered: Retried: all green"
    )
    expect(screen.getByText("Last night's work")).toBeTruthy()
  })

  it("says when nothing needs the owner", () => {
    draw(card(material({ needs: [], bots: [], loose: [], yesterday: null })))
    expect(screen.getByText("Nothing needs you today.")).toBeTruthy()
  })
})
