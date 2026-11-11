/**
 * "Today" for the window (1.14): read on the first holder, again when what
 * it lists may have moved — coalesced, one read at a time, never starved —
 * and dropped with the last holder.
 */
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { BotLive, PersonalAgentToday } from "@/lib/types"

const api = vi.hoisted(() => ({ personalAgentToday: vi.fn() }))
const bus = vi.hoisted(() => ({
  handlers: new Map<string, Set<(p: unknown) => void>>(),
  transport: new Set<() => void>(),
  reconnect: new Set<() => void>(),
}))
vi.mock("@/lib/api", () => api)
vi.mock("@/lib/platform", () => ({
  subscribe: (event: string, handler: (p: unknown) => void) => {
    const set = bus.handlers.get(event) ?? new Set()
    set.add(handler)
    bus.handlers.set(event, set)
    return Promise.resolve(() => set.delete(handler))
  },
  onTransportReconnect: (cb: () => void) => {
    bus.reconnect.add(cb)
    return () => bus.reconnect.delete(cb)
  },
}))
vi.mock("@/lib/transport", () => ({
  onActiveTransportChange: (cb: () => void) => {
    bus.transport.add(cb)
    return () => bus.transport.delete(cb)
  },
}))

import {
  __resetTodayForTests,
  refreshToday,
  TODAY_GAP_MS,
  TODAY_POLL_MS,
  usePersonalAgentToday,
  useToday,
} from "./personal-agent-today-store"

function emit(event: string, payload: unknown) {
  for (const h of bus.handlers.get(event) ?? []) h(payload)
}

function view(n: number): PersonalAgentToday {
  return {
    needs: Array.from({ length: n }, (_, i) => ({
      key: `session:${i}`,
      kind: "session",
      bot_id: null,
      project: null,
      title: `S${i}`,
      text: null,
      at: "2026-11-11T08:00:00Z",
      state: "question",
      row_id: null,
      dispatch_id: null,
      task_id: null,
      conversation_id: i,
      item_id: null,
      notice_id: null,
      agent_type: "codex",
      undo: false,
    })),
    watching: [],
    schedule: [],
    done: [],
    day_start: "2026-11-10T20:00:00Z",
    day_end: "2026-11-11T20:00:00Z",
    at: "2026-11-11T08:00:00Z",
    dispatches: [],
  }
}

function live(bot: number, patch: Partial<BotLive> = {}): BotLive {
  return {
    bot_id: bot,
    work: "idle",
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
    last_activity_at: null,
    updated_at: "2026-11-11T08:00:00Z",
    expires_at: null,
    ...patch,
  } as BotLive
}

/** Let the reads that are due land. */
async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  bus.handlers.clear()
  bus.transport.clear()
  bus.reconnect.clear()
  api.personalAgentToday.mockReset()
  api.personalAgentToday.mockImplementation(async () => view(1))
})

afterEach(() => {
  cleanup()
  __resetTodayForTests()
  vi.useRealTimers()
})

describe("today's feed", () => {
  it("reads at once for the first holder, once for many, and stops with the last", async () => {
    const a = renderHook(() => useToday())
    const b = renderHook(() => useToday())
    await settle()
    expect(api.personalAgentToday).toHaveBeenCalledTimes(1)
    expect(a.result.current?.needs).toHaveLength(1)
    expect(b.result.current?.needs).toHaveLength(1)
    a.unmount()
    b.unmount()
    await settle(TODAY_POLL_MS * 3)
    expect(api.personalAgentToday).toHaveBeenCalledTimes(1)
    refreshToday()
    await settle(TODAY_GAP_MS)
    expect(api.personalAgentToday).toHaveBeenCalledTimes(1)
  })

  it("is not held by a caller that is not active", async () => {
    const { result } = renderHook(() => useToday(false))
    await settle(TODAY_POLL_MS)
    expect(api.personalAgentToday).not.toHaveBeenCalled()
    expect(result.current).toBeNull()
  })

  it("reads again on what can move it, not on a reply streaming in or a step of activity", async () => {
    renderHook(() => useToday())
    await settle()
    const calls = () => api.personalAgentToday.mock.calls.length
    expect(calls()).toBe(1)

    emit("personal-agent://changed", {
      kind: "reply",
      row_id: 1,
      current: null,
    })
    emit("personal-agent://changed", {
      kind: "timeline",
      rows: [{ id: 1, kind: "reply" }],
    })
    await settle(TODAY_GAP_MS)
    expect(calls()).toBe(1)

    emit("personal-agent://changed", {
      kind: "timeline",
      rows: [{ id: 2, kind: "notice" }],
    })
    await settle(TODAY_GAP_MS)
    expect(calls()).toBe(2)

    // A live state: what waits or the work on hand moved — not the rest.
    emit("personal-agent://bots", { kind: "live", bot_id: 3, live: live(3) })
    await settle(TODAY_GAP_MS)
    expect(calls()).toBe(3)
    emit("personal-agent://bots", {
      kind: "live",
      bot_id: 3,
      live: live(3, { work: "busy", unread: 4 }),
    })
    await settle(TODAY_GAP_MS)
    expect(calls()).toBe(3)
    emit("personal-agent://bots", {
      kind: "live",
      bot_id: 3,
      live: live(3, {
        attention: "needs_you",
        needs: { kind: "question", text: "?", since: "x", row_id: 9, count: 1 },
      } as Partial<BotLive>),
    })
    await settle(TODAY_GAP_MS)
    expect(calls()).toBe(4)

    emit("task://changed", {})
    await settle(TODAY_GAP_MS)
    expect(calls()).toBe(5)
    for (const cb of bus.reconnect) cb()
    await settle(TODAY_GAP_MS)
    expect(calls()).toBe(6)
  })

  it("reads a burst once, once more after a read on its way, and never starves", async () => {
    let finish: (() => void) | null = null
    renderHook(() => useToday())
    await settle()
    const calls = () => api.personalAgentToday.mock.calls.length
    expect(calls()).toBe(1)

    for (let i = 0; i < 5; i++) refreshToday()
    await settle(TODAY_GAP_MS)
    expect(calls()).toBe(2)

    // A slow read: asks meanwhile are one read after it.
    api.personalAgentToday.mockImplementation(
      () =>
        new Promise<PersonalAgentToday>((resolve) => {
          finish = () => resolve(view(2))
        })
    )
    refreshToday()
    await settle(TODAY_GAP_MS)
    expect(calls()).toBe(3)
    refreshToday()
    refreshToday()
    await settle(TODAY_GAP_MS * 3)
    expect(calls()).toBe(3)
    api.personalAgentToday.mockImplementation(async () => view(3))
    await act(async () => {
      finish?.()
    })
    await settle(TODAY_GAP_MS)
    expect(calls()).toBe(4)
    expect(usePersonalAgentToday.getState().today?.needs).toHaveLength(3)

    // Asked every 100 ms for two seconds: still read once a gap.
    const before = calls()
    for (let i = 0; i < 20; i++) {
      refreshToday()
      await settle(100)
    }
    expect(calls() - before).toBeGreaterThanOrEqual(4)
  })

  it("reads every few seconds while the window shows, for the sessions that push nothing", async () => {
    renderHook(() => useToday())
    await settle()
    await settle(TODAY_POLL_MS + TODAY_GAP_MS)
    expect(api.personalAgentToday).toHaveBeenCalledTimes(2)
  })

  it("forgets another backend's day when the transport changes, and reads the new one", async () => {
    const { result } = renderHook(() => useToday())
    await settle()
    expect(result.current?.needs).toHaveLength(1)
    api.personalAgentToday.mockImplementation(async () => view(4))
    await act(async () => {
      for (const cb of bus.transport) cb()
    })
    await settle()
    expect(result.current?.needs).toHaveLength(4)
  })
})
