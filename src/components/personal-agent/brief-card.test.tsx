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
  personalAgentTimelineRows: vi.fn(async (): Promise<unknown[]> => []),
  personalAgentNoticeAct: vi.fn(async () => ({})),
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
vi.mock("@/stores/personal-agent-activity-store", () => ({
  refreshActivity: vi.fn(),
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
    // The card is the message: no bubble round it, its heading its first
    // line.
    const self = container.querySelector("[data-pa-brief-card]")!
    expect(self.hasAttribute("data-pa-card-message")).toBe(true)
    expect(self.closest(".pa-agent-bubble")).toBeNull()
    expect(self.firstElementChild?.textContent).toContain("Morning brief")
    expect(
      screen.getByText(
        "codeg wrote this from its records — the assistant couldn't write it."
      )
    ).toBeTruthy()
    expect(screen.getByText("Needs you")).toBeTruthy()
    expect(screen.getByText("Windows build")).toBeTruthy()
    // A row each, as an assistant's list is drawn: who or what over what
    // about it, a face or an icon first — no card of its own.
    const lines = (sel: string) =>
      [...(container.querySelector(sel)?.querySelectorAll("p") ?? [])].map(
        (p) => p.textContent
      )
    const bot = container.querySelector("[data-pa-brief-bot='2']")
    expect(lines("[data-pa-brief-bot='2']")).toEqual([
      "Dev",
      "finished 2 (Bump deps; Fix lint) · 1 waiting on you",
    ])
    expect(bot?.className).toContain("border-t")
    expect(bot?.className).not.toContain("bg-")
    expect(lines("[data-pa-brief-loose='item']")).toEqual([
      "Look at the flaky test",
      "untouched for 9 days",
    ])
    expect(
      container.querySelector("[data-pa-brief-loose='item'] svg")
    ).toBeTruthy()
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
    // "To Ops:" over the message, its colon gone; what came back under it.
    expect(
      [...(line?.querySelectorAll("p") ?? [])].map((p) => p.textContent)
    ).toEqual([
      "To Ops",
      "Retry the build tonight",
      "answered: Retried: all green",
    ])
    expect(screen.getByText("Last night's work")).toBeTruthy()
  })

  it("states the week once a week: work, tokens by day and by assistant", () => {
    const { container } = draw(
      card(
        material({
          week: {
            label: "2026-W46",
            first: "2026-11-09",
            last: "2026-11-15",
            so_far: false,
            dispatched: 5,
            by_bot: [{ id: 2, name: "Dev", n: 4 }],
            by_mode: { task: 3, session: 2 },
            completed: 4,
            failed: 1,
            settled: 5,
            first_pass: 3,
            caught: 1,
            retried: 2,
            routine_done: 0,
            ci_fixed: 3,
            merged: 0,
            asked: 3,
            plans: 1,
            answered_by: [{ id: 2, name: "Dev", n: 2 }],
            forwarded: 1,
            messages: 0,
            threads: 0,
            loops: 0,
            tokens: 1_500_000,
            tokens_by_day: [
              ["2026-11-09", 1_000_000],
              ["2026-11-10", 500_000],
            ],
            tokens_by_bot: [
              { bot_id: 2, name: "Dev", own: 200_000, handed_out: 1_300_000 },
            ],
            unblock_minutes: 14,
            unblocked: 6,
            unblock_before: 20,
            held: { merged: 3, deferred: 1, kept: 0 },
            briefs: 4,
            wraps: 2,
            tonight: 1,
            proposals: 4,
            proposals_taken: 2,
            proposals_dismissed: 2,
            muted_rules: [],
            lowered: ["idle"],
            changes: 4,
            changes_undone: 3,
            memory: 0,
            memory_undone: 0,
            reminders: 0,
            reminders_done: 0,
            reminders_snoozed: 0,
            repeat_offers: 0,
            idle_items: 0,
            hours_note: null,
            asks: [],
          },
        })
      )
    )
    const week = container.querySelector("[data-pa-brief-part='week']")!
    expect(week.textContent).toContain("Last week (11-09 – 11-15)")
    expect(
      container.querySelector("[data-pa-week-line='work']")?.textContent
    ).toBe(
      "Handed out 5 (board 3 · session 2) · completed 4, failed 1 · first time 3 of 5"
    )
    expect(
      container.querySelector("[data-pa-week-line='done']")?.textContent
    ).toBe(
      "Done for you: 1 sent back by acceptance · 2 retried · 3 CI fixes · 0 routine runs · 0 merged"
    )
    expect(
      container.querySelector("[data-pa-week-line='unblock']")?.textContent
    ).toContain("the week before 20 min")
    expect(
      container.querySelector("[data-pa-week-line='lowered']")?.textContent
    ).toBe("codeg lowered: idle")
    expect(container.querySelector("[data-pa-week-line='reminders']")).toBe(
      null
    )
    expect(
      container.querySelector("[data-pa-week-tokens]")?.textContent
    ).toContain("Tokens: 1.5M")
    expect(container.querySelector("[data-pa-week-bot='2']")?.textContent).toBe(
      "Dev 1.5M — its own 200.0k, its handed-out work 1.3M"
    )
  })

  it("says when nothing needs the owner", () => {
    draw(card(material({ needs: [], bots: [], loose: [], yesterday: null })))
    expect(screen.getByText("Nothing needs you today.")).toBeTruthy()
  })
})

describe("last night's tidy-ups in the brief (7.7)", () => {
  it("get a line each, with its buttons, in a part of their own", async () => {
    const tidied = need({
      key: "tidy:9",
      kind: "tidy",
      bot_id: 2,
      title: "Tidied memory (2026-11-12) — 1 updated",
      state: "acted",
      row_id: 41,
      notice_id: 9,
      undo: true,
    })
    const { container } = draw(card(material({ tidied: [tidied] })))
    const part = container.querySelector("[data-pa-brief-tidied]")
    expect(part?.textContent).toContain("Tidied up last night")
    expect(container.querySelector("[data-pa-tidy-line='acted']")).toBeTruthy()
    expect(screen.getByText("Undo all")).toBeTruthy()
    expect(api.personalAgentTimelineRows).toHaveBeenCalledWith([41], 2)
  })
})
