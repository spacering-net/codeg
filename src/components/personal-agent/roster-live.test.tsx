import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { BotLive, RosterEntry, TimelineRow } from "@/lib/types"
import {
  __resetRosterForTests,
  ELSEWHERE_POLL_MS,
  usePersonalAgentRoster,
} from "@/stores/personal-agent-roster-store"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

const api = vi.hoisted(() => ({
  personalAgentBots: vi.fn(),
  personalAgentRosterAct: vi.fn(async () => {}),
  personalAgentStopAll: vi.fn(async () => {}),
  personalAgentBotCopy: vi.fn(),
  personalAgentTurnSteps: vi.fn(),
  personalAgentCancel: vi.fn(async () => {}),
  personalAgentTemplates: vi.fn(async () => [
    {
      id: "review",
      name: "Reviewer",
      job: "",
      description: "",
      instructions: "",
      opener: "",
      options: ["a", "b", "c"],
      other: "Other",
      modes: ["session"],
      division: "review",
      project_option: null,
    },
  ]),
  personalAgentResend: vi.fn(),
}))
vi.mock("@/lib/api", () => api)
const events = vi.hoisted(() => ({
  handlers: new Map<string, (p: unknown) => void>(),
}))
vi.mock("@/lib/platform", () => ({
  subscribe: (name: string, fn: (p: unknown) => void) => {
    events.handlers.set(name, fn)
    return Promise.resolve(() => events.handlers.delete(name))
  },
  onTransportReconnect: () => () => {},
}))
const pa = vi.hoisted(() => ({ snapshot: null as unknown }))
vi.mock("@/contexts/personal-agent-context", () => ({
  useBotId: () => 1,
  usePersonalAgent: () => ({
    botId: 1,
    snapshot: pa.snapshot,
    dispatchById: new Map(),
    liveReplies: new Map(),
    rows: [],
  }),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ setRoute: vi.fn(), openConversations: vi.fn() }),
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({ openTab: vi.fn() }),
}))

import { OwnerBubble } from "./owner-bubble"
import { buildMessageItems, type MessageItem } from "./message-items"
import { ownerWaitTargets, waitsForOwner } from "./message-list"
import { PersonalAgentRoster } from "./roster"
import { PageScopeContext, type PageScope } from "./shared"
import { StatusLine, VAGUE_DELAY_MS } from "./status-line"

const NOW = Date.now()
const iso = (ms: number) => new Date(NOW + ms).toISOString()

function live(id: number, patch: Partial<BotLive> = {}): BotLive {
  return {
    bot_id: id,
    work: "done",
    attention: "none",
    needs: null,
    unread: 0,
    activity: null,
    activity_known: true,
    work_on_hand: [],
    awaiting: [],
    face: "idle",
    flash: null,
    connected: true,
    last_line: null,
    last_activity_at: iso(-60_000),
    updated_at: iso(-1000),
    expires_at: null,
    ...patch,
  }
}

function entry(
  id: number,
  name: string,
  patch: Partial<BotLive> = {},
  roster: Partial<RosterEntry["roster"]> = {}
): RosterEntry {
  return {
    id,
    kind: id === 1 ? "primary" : "worker",
    uid: `u${id}`,
    name,
    avatar: { kind: "face", shape: "blob", color: id === 1 ? "black" : "teal" },
    template: id === 1 ? null : "review",
    executor_assistant_id: null,
    created_at: iso(-86_400_000),
    roster: {
      sort_order: 0,
      pinned_at: null,
      section: null,
      hidden: false,
      muted: false,
      unread_mark: false,
      notify: true,
      ...roster,
    },
    live: live(id, patch),
  }
}

const scope: PageScope = {
  readOnly: false,
  agentName: "Nova",
  liveRowId: null,
  connectionId: null,
  agentType: null,
  onQuote: vi.fn(),
  jumpTo: vi.fn(),
  rowsById: new Map(),
}

function wrap(node: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PageScopeContext.Provider value={scope}>
        {node}
      </PageScopeContext.Provider>
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  __resetRosterForTests()
  usePersonalAgentUi.setState({ viewBot: null, settings: null })
  pa.snapshot = {
    agent: {
      id: 1,
      name: "Nova",
      avatar: { kind: "face", shape: "blob", color: "black" },
    },
    status: { engine: "here", connected: true, turn: null },
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe("the roster", () => {
  it("says what each is up to: what waits on the owner first, then what it does, then its last words", async () => {
    api.personalAgentBots.mockResolvedValue([
      entry(1, "Nova", { last_line: { text: "All set.", at: iso(-5000) } }),
      entry(2, "Dev", {
        work: "busy",
        face: "working",
        expires_at: iso(30_000),
        activity: {
          step: {
            n: 3,
            kind: "edit",
            target: "startup.rs",
            started_at: iso(-1000),
            status: "in_progress",
          },
          work: { dispatch_id: 234, title: "Fix the white screen" },
        },
        work_on_hand: [
          {
            dispatch_id: 234,
            title: "Fix the white screen",
            mode: "task",
            state: "running",
            work_task_id: 7,
            conversation_id: null,
            ladder: "working",
          },
        ],
      }),
      entry(3, "Rev", {
        attention: "needs_you",
        face: "waiting",
        needs: {
          kind: "question",
          text: "Keep the old layer?",
          since: iso(-5000),
          row_id: 9,
          count: 1,
        },
      }),
    ])
    wrap(<PersonalAgentRoster compact={false} readOnly={false} />)
    await screen.findByText("Dev")
    const rows = [...document.querySelectorAll("[data-pa-roster-bot]")]
    // The primary on top, then the waiting, then the working.
    expect(rows.map((r) => r.getAttribute("data-pa-roster-bot"))).toEqual([
      "1",
      "3",
      "2",
    ])
    const line = (id: number) =>
      document.querySelector(
        `[data-pa-roster-bot='${id}'] [data-pa-roster-line]`
      )?.textContent
    expect(line(1)).toBe("All set.")
    expect(line(3)).toBe("Needs your answer: Keep the old layer?")
    expect(line(2)).toBe("#234 Fix the white screen: Editing startup.rs")
    // Its face is its state, its dot what it wants.
    const face = (id: number) =>
      document.querySelector(`[data-pa-roster-bot='${id}'] [data-bot-look]`)!
    expect(face(2).getAttribute("data-bot-look")).toBe("working")
    expect(face(3).getAttribute("data-bot-look")).toBe("waiting")
    expect(
      face(3).querySelector("[data-bot-dot]")?.getAttribute("data-bot-dot")
    ).toBe("waiting")
    expect(face(3).getAttribute("aria-label")).toBe("Rev, waiting for you")
  })

  it("puts work the owner can merge before what it is doing, in a calm tone", async () => {
    const hand = (id: number, ladder: "working" | "mergeable") => ({
      dispatch_id: id,
      title: `Task ${id}`,
      mode: "task" as const,
      state:
        ladder === "mergeable" ? ("review" as const) : ("running" as const),
      work_task_id: id,
      conversation_id: null,
      ladder,
    })
    api.personalAgentBots.mockResolvedValue([
      entry(1, "Nova"),
      entry(2, "Dev", {
        work: "busy",
        face: "working",
        expires_at: iso(30_000),
        activity: {
          step: {
            n: 1,
            kind: "edit",
            target: "a.rs",
            started_at: iso(-1000),
            status: "in_progress",
          },
        },
        work_on_hand: [hand(233, "working"), hand(234, "mergeable")],
      }),
    ])
    wrap(<PersonalAgentRoster compact={false} readOnly={false} />)
    await screen.findByText("Dev")
    const line = document.querySelector(
      "[data-pa-roster-bot='2'] [data-pa-roster-line]"
    )!
    expect(line.textContent).toBe("#234 ready to merge: Task 234")
    expect(line.getAttribute("data-pa-roster-line")).toBe("ready")
    expect(line.className).toContain("text-teal-700")
  })

  it("follows each one's state as it is pushed, and lets a stale one rest", async () => {
    api.personalAgentBots.mockResolvedValue([entry(1, "Nova"), entry(2, "Dev")])
    wrap(<PersonalAgentRoster compact={false} readOnly={false} />)
    await screen.findByText("Dev")
    act(() =>
      events.handlers.get("personal-agent://bots")?.({
        kind: "live",
        bot_id: 2,
        live: live(2, {
          work: "busy",
          face: "working",
          updated_at: iso(0),
          expires_at: iso(-1),
          activity: {
            step: {
              n: 1,
              kind: "test",
              started_at: iso(0),
              status: "in_progress",
            },
          },
        }),
      })
    )
    // Pushed, but already past its expiry: at rest, saying so on hover.
    const face = document.querySelector(
      "[data-pa-roster-bot='2'] [data-bot-look]"
    )!
    expect(face.getAttribute("data-bot-look")).toBe("idle")
    expect(face.getAttribute("aria-label")).toBe(
      "Dev, Status unavailable for now"
    )
    act(() =>
      events.handlers.get("personal-agent://bots")?.({
        kind: "live",
        bot_id: 2,
        live: live(2, {
          work: "busy",
          face: "working",
          updated_at: iso(10),
          expires_at: iso(30_000),
          activity: {
            step: {
              n: 1,
              kind: "test",
              started_at: iso(0),
              status: "in_progress",
            },
          },
        }),
      })
    )
    // The face changes through a blink.
    await waitFor(() =>
      expect(
        document
          .querySelector("[data-pa-roster-bot='2'] [data-bot-look]")!
          .getAttribute("data-bot-look")
      ).toBe("working")
    )
    expect(screen.getByText("Running the tests")).toBeTruthy()
  })

  it("arranges one from its menu, and hides the hidden ones under a count", async () => {
    api.personalAgentBots.mockResolvedValue([
      entry(1, "Nova"),
      entry(2, "Dev", {}, { pinned_at: iso(-100) }),
      entry(3, "Ops", {}, { section: "codeg" }),
      entry(4, "Old", {}, { hidden: true }),
    ])
    wrap(<PersonalAgentRoster compact={false} readOnly={false} />)
    await screen.findByText("Dev")
    expect(screen.getByText("Pinned")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Fold codeg" })).toBeTruthy()
    expect(screen.queryByText("Old")).toBeNull()
    fireEvent.click(screen.getByText("1 hidden"))
    expect(screen.getByText("Old")).toBeTruthy()
    // Its menu.
    fireEvent.contextMenu(screen.getByText("Ops"))
    const menu = await screen.findByRole("menu")
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Pin" }))
    expect(api.personalAgentRosterAct).toHaveBeenCalledWith(3, { act: "pin" })
    fireEvent.contextMenu(screen.getByText("Ops"))
    fireEvent.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", {
        name: "Mark as unread",
      })
    )
    expect(api.personalAgentRosterAct).toHaveBeenLastCalledWith(3, {
      act: "mark_unread",
    })
    // Folding a group.
    fireEvent.click(screen.getByRole("button", { name: "Fold codeg" }))
    expect(screen.queryByText("Ops")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Unfold codeg" }))
    expect(screen.getByText("Ops")).toBeTruthy()
  })

  it("finds one by name or role, and opening one takes the owner's unread mark away", async () => {
    api.personalAgentBots.mockResolvedValue([
      entry(1, "Nova"),
      entry(2, "Dev", {}, { unread_mark: true }),
      entry(3, "Ops"),
    ])
    wrap(<PersonalAgentRoster compact={false} readOnly={false} />)
    await screen.findByText("Dev")
    fireEvent.click(screen.getByRole("button", { name: "Search assistants" }))
    fireEvent.change(screen.getByPlaceholderText("Search assistants"), {
      target: { value: "review" },
    })
    // Both are reviewers by template: the role matches.
    await waitFor(() => expect(screen.getByText("Ops")).toBeTruthy())
    fireEvent.change(screen.getByPlaceholderText("Search assistants"), {
      target: { value: "dev" },
    })
    expect(screen.queryByText("Ops")).toBeNull()
    fireEvent.click(screen.getByText("Dev"))
    expect(usePersonalAgentUi.getState().viewBot).toBe(2)
    await waitFor(() =>
      expect(api.personalAgentRosterAct).toHaveBeenCalledWith(2, {
        act: "mark_read",
      })
    )
  })
})

describe("the roster's store (review round 1)", () => {
  it("keeps a push newer than a read that was on its way, and one that came before the first read", () => {
    const store = usePersonalAgentRoster.getState()
    // Pushed before anything was read.
    store.applyLive(live(2, { attention: "needs_you", updated_at: iso(50) }))
    store.setEntries([
      entry(1, "Nova"),
      entry(2, "Dev", { updated_at: iso(10) }),
    ])
    expect(
      usePersonalAgentRoster.getState().entries!.find((e) => e.id === 2)!.live
        .attention
    ).toBe("needs_you")
    // A read that left before a newer push lands after it.
    usePersonalAgentRoster
      .getState()
      .applyLive(live(2, { attention: "unread", updated_at: iso(100) }))
    usePersonalAgentRoster
      .getState()
      .setEntries([entry(1, "Nova"), entry(2, "Dev", { updated_at: iso(60) })])
    expect(
      usePersonalAgentRoster.getState().entries!.find((e) => e.id === 2)!.live
        .attention
    ).toBe("unread")
    // An older push does not undo a newer read.
    usePersonalAgentRoster
      .getState()
      .setEntries([
        entry(2, "Dev", { attention: "none", updated_at: iso(200) }),
      ])
    usePersonalAgentRoster
      .getState()
      .applyLive(live(2, { attention: "needs_you", updated_at: iso(150) }))
    expect(usePersonalAgentRoster.getState().entries![0].live.attention).toBe(
      "none"
    )
  })

  it("is read again now and then where another process runs the assistants", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    api.personalAgentBots.mockResolvedValue([
      entry(1, "Nova", { activity_known: false }),
    ])
    wrap(<PersonalAgentRoster compact={false} readOnly />)
    await screen.findByText("Nova")
    const reads = api.personalAgentBots.mock.calls.length
    await act(async () => {
      vi.advanceTimersByTime(ELSEWHERE_POLL_MS + 200)
    })
    await waitFor(() =>
      expect(api.personalAgentBots.mock.calls.length).toBeGreaterThan(reads)
    )
  })

  it("leaves the open one marked when the owner marks it", async () => {
    api.personalAgentBots.mockResolvedValue([entry(1, "Nova"), entry(2, "Dev")])
    usePersonalAgentUi.setState({ viewBot: 2 })
    wrap(<PersonalAgentRoster compact={false} readOnly={false} />)
    await screen.findByText("Dev")
    act(() =>
      usePersonalAgentRoster
        .getState()
        .setEntries([
          entry(1, "Nova"),
          entry(2, "Dev", {}, { unread_mark: true }),
        ])
    )
    await new Promise((r) => setTimeout(r, 30))
    expect(api.personalAgentRosterAct).not.toHaveBeenCalledWith(2, {
      act: "mark_read",
    })
  })
})

describe("the status line", () => {
  const busy = (kind: string, patch: Partial<BotLive> = {}) =>
    live(1, {
      work: "busy",
      face: kind === "think" ? "thinking" : "working",
      expires_at: iso(30_000),
      activity: {
        step: {
          n: 2,
          kind,
          target: "parser.rs",
          started_at: iso(0),
          status: "in_progress",
        },
        turn: 5,
      },
      ...patch,
    })

  it("says what the turn is on, the vague only once it has lasted, and lists the turn's steps", async () => {
    api.personalAgentBots.mockResolvedValue([entry(1, "Nova", busy("edit"))])
    pa.snapshot = {
      agent: {
        id: 1,
        name: "Nova",
        avatar: { kind: "face", shape: "blob", color: "black" },
      },
      status: {
        engine: "here",
        connected: true,
        turn: { batch_id: 5, kind: "delivery" },
      },
    }
    api.personalAgentTurnSteps.mockResolvedValue([
      {
        n: 1,
        kind: "read",
        target: "AGENTS.md",
        started_at: iso(0),
        status: "completed",
      },
      {
        n: 2,
        kind: "edit",
        target: "parser.rs",
        started_at: iso(0),
        status: "completed",
        added: 14,
        removed: 10,
      },
    ])
    wrap(<StatusLine botId={1} name="Nova" />)
    const text = await screen.findByText("Editing parser.rs")
    expect(text.className).toContain("activity-shimmer")
    // A vague step: the specific one stays till it has lasted.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    act(() =>
      usePersonalAgentRoster
        .getState()
        .applyLive(busy("think", { updated_at: iso(100) }))
    )
    expect(screen.getByText("Editing parser.rs")).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(VAGUE_DELAY_MS + 10)
    })
    expect(
      document.querySelector("[data-pa-status-text]")!.textContent
    ).toMatch(/Thinking|Mulling|Working out/)
    vi.useRealTimers()
    // Its steps.
    fireEvent.click(screen.getByRole("button", { expanded: false }))
    expect(await screen.findByText("Edited parser.rs +14 −10")).toBeTruthy()
    expect(screen.getByText("Read AGENTS.md")).toBeTruthy()
    // And the turn can be stopped from here.
    fireEvent.click(screen.getByRole("button", { name: "Stop the reply" }))
    expect(api.personalAgentCancel).toHaveBeenCalled()
  })

  it("folds away when its state went stale, whatever an old snapshot says", async () => {
    api.personalAgentBots.mockResolvedValue([
      entry(1, "Nova", busy("think", { expires_at: iso(-1000) })),
    ])
    pa.snapshot = {
      agent: {
        id: 1,
        name: "Nova",
        avatar: { kind: "face", shape: "blob", color: "black" },
      },
      status: {
        engine: "here",
        connected: true,
        turn: { batch_id: 5, kind: "delivery" },
      },
    }
    wrap(<StatusLine botId={1} name="Nova" />)
    await waitFor(() => expect(api.personalAgentBots).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, VAGUE_DELAY_MS + 100))
    expect(document.querySelector("[data-pa-status-line]")).toBeNull()
  })

  it("folds away when nothing runs", async () => {
    api.personalAgentBots.mockResolvedValue([entry(1, "Nova")])
    wrap(<StatusLine botId={1} name="Nova" />)
    await waitFor(() => expect(api.personalAgentBots).toHaveBeenCalled())
    expect(document.querySelector("[data-pa-status-line]")).toBeNull()
  })
})

function ownerRow(patch: Partial<TimelineRow>): TimelineRow {
  return {
    id: 30,
    segment_id: null,
    batch_id: null,
    kind: "owner",
    status: "queued",
    body: "Fix the login",
    data: null,
    dispatch_id: null,
    ref_id: null,
    reply_to: null,
    read_at: null,
    event_id: null,
    seen_at: null,
    created_at: iso(0),
    updated_at: iso(0),
    ...patch,
  }
}

function ownerItem(row: TimelineRow) {
  return buildMessageItems([row]).find((i) => i.kind === "owner") as Extract<
    MessageItem,
    { kind: "owner" }
  >
}

describe("the owner's message", () => {
  it("gets a 👍 once taken, popping on only when it comes while shown", () => {
    const { rerender } = wrap(<OwnerBubble item={ownerItem(ownerRow({}))} />)
    expect(document.querySelector("[data-pa-received]")).toBeNull()
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <PageScopeContext.Provider value={scope}>
          <OwnerBubble
            item={ownerItem(
              ownerRow({ status: "delivered", read_at: iso(500) })
            )}
          />
        </PageScopeContext.Provider>
      </NextIntlClientProvider>
    )
    const mark = document.querySelector("[data-pa-received]")!
    expect(mark.textContent).toBe("👍")
    expect(mark.className).toContain("motion-pop")
    cleanup()
    wrap(
      <OwnerBubble
        item={ownerItem(ownerRow({ status: "delivered", read_at: iso(500) }))}
      />
    )
    expect(
      document.querySelector("[data-pa-received]")!.className
    ).not.toContain("motion-pop")
  })

  it("says what it waits for after two seconds", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    pa.snapshot = {
      agent: { id: 1, name: "Nova" },
      status: { engine: "here", connected: false, turn: null },
    }
    // Sent just now.
    wrap(
      <OwnerBubble
        item={ownerItem(ownerRow({ created_at: new Date().toISOString() }))}
      />
    )
    expect(document.querySelector("[data-pa-wait-note]")).toBeNull()
    act(() => {
      vi.advanceTimersByTime(2100)
    })
    expect(document.querySelector("[data-pa-wait-note]")!.textContent).toBe(
      "Waking Nova…"
    )
    cleanup()
    pa.snapshot = {
      agent: { id: 1, name: "Nova" },
      status: {
        engine: "here",
        connected: true,
        turn: { batch_id: 3, kind: "delivery", for_owner: false },
      },
    }
    wrap(<OwnerBubble item={ownerItem(ownerRow({ created_at: iso(-5000) }))} />)
    expect(document.querySelector("[data-pa-wait-note]")!.textContent).toBe(
      "Making way"
    )
  })
})

describe("the pill of what needs the owner", () => {
  it("counts the cards waiting for them, where each is drawn", () => {
    const row = (
      id: number,
      kind: TimelineRow["kind"],
      data: Record<string, unknown>
    ) => ownerRow({ id, kind, data, status: null, body: "x" })
    expect(waitsForOwner(row(1, "question", { state: "pending" }))).toBe(true)
    expect(waitsForOwner(row(2, "question", { state: "answered" }))).toBe(false)
    expect(
      waitsForOwner(row(3, "notice", { notice: "choice", state: "open" }))
    ).toBe(true)
    expect(
      waitsForOwner(
        row(4, "notice", { notice: "proposal", state: "open", why: "suggest" })
      )
    ).toBe(false)
    expect(
      waitsForOwner(row(5, "notice", { notice: "stopped", state: "open" }))
    ).toBe(false)
    const items = buildMessageItems([
      row(10, "notice", { notice: "loop", state: "open" }),
      row(11, "notice", { notice: "changed", state: "applied" }),
    ])
    expect(ownerWaitTargets(items)).toEqual([10])
  })
})
