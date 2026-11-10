import { useEffect } from "react"
import { act, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type {
  DispatchInfo,
  PersonalAgentChange,
  PersonalAgentSnapshot,
  TimelineChanges,
  TimelinePage,
  TimelineRow,
} from "@/lib/types"

const api = vi.hoisted(() => ({
  personalAgentGet: vi.fn(),
  personalAgentTimeline: vi.fn(),
  personalAgentTimelineRows: vi.fn(),
  personalAgentTimelineUpdatedSince: vi.fn(),
  personalAgentDispatches: vi.fn(),
}))
vi.mock("@/lib/api", () => api)

const bus = vi.hoisted(() => ({
  handler: null as ((change: PersonalAgentChange) => void) | null,
}))
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(
    async (_event: string, handler: (change: PersonalAgentChange) => void) => {
      bus.handler = handler
      return () => {
        bus.handler = null
      }
    }
  ),
  onTransportReconnect: vi.fn(() => () => {}),
}))

import {
  PersonalAgentProvider,
  usePersonalAgent,
  usePrimaryAgent,
  ViewedPersonalAgentProvider,
} from "./personal-agent-context"

type Ctx = ReturnType<typeof usePersonalAgent>
let ctx: Ctx | null = null
function Probe({ onValue }: { onValue: (value: Ctx) => void }) {
  const value = usePersonalAgent()
  useEffect(() => onValue(value))
  return null
}
const keep = (value: Ctx) => {
  ctx = value
}

function row(
  id: number,
  kind: TimelineRow["kind"],
  updated: string,
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
    created_at: updated,
    updated_at: updated,
    ...patch,
  }
}

function snapshot(engine: "here" | "elsewhere"): PersonalAgentSnapshot {
  return {
    agent: null,
    status: {
      engine,
      live_reply: null,
      pending_permission: false,
      pending_question: false,
    },
  } as unknown as PersonalAgentSnapshot
}

function page(rows: TimelineRow[]): TimelinePage {
  return { rows, has_older: false, too_far: false }
}

function dispatch(id: number, state: DispatchInfo["state"]): DispatchInfo {
  return { id, state } as unknown as DispatchInfo
}

/** Let every pending promise callback run. */
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  ctx = null
  for (const fn of Object.values(api)) fn.mockReset()
  api.personalAgentTimelineRows.mockResolvedValue([])
  api.personalAgentDispatches.mockResolvedValue([])
})

afterEach(() => {
  vi.useRealTimers()
})

describe("PersonalAgentProvider, whose broadcast it is", () => {
  /**
   * The primary's store knows the primary's id only once its snapshot is
   * back. A broadcast naming an assistant that lands before then may be the
   * primary's own: what it carried is not taken as is, but everything is
   * read again — so a card written in that gap reaches the page.
   */
  it("reads itself again on a broadcast it cannot place, and keeps a card written meanwhile", async () => {
    const T1 = "2026-11-04T10:00:01Z"
    const T2 = "2026-11-04T10:00:02Z"
    const first = row(1, "owner", T1)
    const card = row(2, "notice", T2)
    let identity: ((s: PersonalAgentSnapshot) => void) | null = null
    api.personalAgentGet.mockImplementationOnce(
      () =>
        new Promise<PersonalAgentSnapshot>((resolve) => {
          identity = resolve
        })
    )
    api.personalAgentGet.mockResolvedValue({
      ...snapshot("here"),
      agent: { id: 7 },
    } as unknown as PersonalAgentSnapshot)
    api.personalAgentTimeline.mockResolvedValueOnce(page([first]))
    api.personalAgentTimeline.mockResolvedValue(page([first, card]))
    render(
      <PersonalAgentProvider>
        <Probe onValue={keep} />
      </PersonalAgentProvider>
    )
    await act(flush)
    expect(ctx?.rows.map((r) => r.id)).toEqual([1])
    // The card lands, named as assistant 7's, before the identity is known.
    await act(async () => {
      bus.handler?.({ bot_id: 7, kind: "timeline", rows: [card] })
      await flush()
    })
    expect(api.personalAgentTimeline).toHaveBeenCalledTimes(2)
    expect(ctx?.rows.map((r) => r.id)).toEqual([1, 2])
    // A worker's rows are not ours; the primary's before it was set up are.
    await act(async () => {
      bus.handler?.({
        bot_id: 9,
        kind: "timeline",
        rows: [row(3, "owner", T2)],
      })
      bus.handler?.({
        bot_id: 0,
        kind: "timeline",
        rows: [row(4, "owner", T2)],
      })
      await flush()
    })
    expect(ctx?.rows.map((r) => r.id)).toEqual([1, 2, 4])
    // Once the identity is known, 7's broadcasts are taken as they come and
    // 9's still are not.
    await act(async () => {
      identity?.({
        ...snapshot("here"),
        agent: { id: 7 },
      } as unknown as PersonalAgentSnapshot)
      await flush()
    })
    const calls = api.personalAgentTimeline.mock.calls.length
    await act(async () => {
      bus.handler?.({
        bot_id: 7,
        kind: "timeline",
        rows: [row(5, "owner", T2)],
      })
      bus.handler?.({
        bot_id: 9,
        kind: "timeline",
        rows: [row(6, "owner", T2)],
      })
      await flush()
    })
    expect(api.personalAgentTimeline).toHaveBeenCalledTimes(calls)
    expect(ctx?.rows.map((r) => r.id)).toEqual([1, 2, 4, 5])
  })

  it("a worker's store takes only its own and never guesses", async () => {
    const T1 = "2026-11-04T10:00:01Z"
    api.personalAgentGet.mockResolvedValue({
      ...snapshot("here"),
      agent: { id: 9 },
    } as unknown as PersonalAgentSnapshot)
    api.personalAgentTimeline.mockResolvedValue(page([]))
    render(
      <PersonalAgentProvider botId={9}>
        <Probe onValue={keep} />
      </PersonalAgentProvider>
    )
    await act(flush)
    expect(api.personalAgentGet).toHaveBeenLastCalledWith(9)
    expect(api.personalAgentTimeline).toHaveBeenLastCalledWith(
      null,
      60,
      null,
      9
    )
    await act(async () => {
      bus.handler?.({
        bot_id: 9,
        kind: "timeline",
        rows: [row(1, "owner", T1)],
      })
      bus.handler?.({
        bot_id: 7,
        kind: "timeline",
        rows: [row(2, "owner", T1)],
      })
      bus.handler?.({
        bot_id: 0,
        kind: "timeline",
        rows: [row(3, "owner", T1)],
      })
      bus.handler?.({ kind: "timeline", rows: [row(4, "owner", T1)] })
      await flush()
    })
    expect(ctx?.rows.map((r) => r.id)).toEqual([1])
  })
})

describe("PersonalAgentProvider, read-only reconciliation", () => {
  /**
   * An older reply held on the page settles at T2 while the newest page
   * moves on to T3. When the read of changed rows fails, the next poll must
   * still read from the last mark it reached (T1) — the newest page says
   * nothing about the older rows held.
   */
  it("keeps its mark when a read of changed rows fails, and catches up after", async () => {
    const T1 = "2026-11-04T10:00:01Z"
    const T2 = "2026-11-04T10:00:02Z"
    const T3 = "2026-11-04T10:00:03Z"
    const running = row(5, "reply", T1, { data: { state: "running" } })
    const settled = row(5, "reply", T2, {
      body: "Done.",
      data: { state: "done" },
    })
    const later = row(9, "owner", T3, { status: "queued" })
    api.personalAgentGet.mockResolvedValue(snapshot("elsewhere"))
    api.personalAgentTimeline
      .mockResolvedValueOnce(page([running]))
      .mockResolvedValue(page([later]))
    const changes: TimelineChanges = { rows: [settled, later], next: null }
    api.personalAgentTimelineUpdatedSince
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(changes)

    render(
      <PersonalAgentProvider>
        <Probe onValue={keep} />
      </PersonalAgentProvider>
    )
    await act(flush)
    expect(ctx!.rows.map((r) => r.id)).toEqual([5])

    // First poll: the newest page brings row 9; the read of changes fails.
    await act(async () => {
      vi.advanceTimersByTime(5_000)
      await flush()
    })
    expect(api.personalAgentTimelineUpdatedSince).toHaveBeenCalledTimes(1)
    expect(api.personalAgentTimelineUpdatedSince.mock.calls[0][0]).toBe(T1)

    // Second poll reads from the same mark, and the reply settles.
    await act(async () => {
      vi.advanceTimersByTime(5_000)
      await flush()
    })
    expect(api.personalAgentTimelineUpdatedSince).toHaveBeenCalledTimes(2)
    expect(api.personalAgentTimelineUpdatedSince.mock.calls[1][0]).toBe(T1)
    const reply = ctx!.rows.find((r) => r.id === 5)
    expect(reply?.data?.state).toBe("done")

    // Then the mark moves to the newest change it read.
    await act(async () => {
      vi.advanceTimersByTime(5_000)
      await flush()
    })
    expect(api.personalAgentTimelineUpdatedSince.mock.calls[2][0]).toBe(T3)
  })

  it("goes on from where a long read of changes stopped", async () => {
    const T1 = "2026-11-04T10:00:01Z"
    const T2 = "2026-11-04T10:00:02Z"
    api.personalAgentGet.mockResolvedValue(snapshot("elsewhere"))
    api.personalAgentTimeline.mockResolvedValue(page([row(1, "owner", T1)]))
    // More than one poll's worth of continuation pages.
    const cursor = { updated_at: T2, id: 1 }
    api.personalAgentTimelineUpdatedSince.mockResolvedValue({
      rows: [row(1, "owner", T2)],
      next: cursor,
    })
    render(
      <PersonalAgentProvider>
        <Probe onValue={keep} />
      </PersonalAgentProvider>
    )
    await act(flush)
    await act(async () => {
      vi.advanceTimersByTime(5_000)
      for (let i = 0; i < 30; i++) await flush()
    })
    const calls = api.personalAgentTimelineUpdatedSince.mock.calls.length
    api.personalAgentTimelineUpdatedSince.mockClear()
    await act(async () => {
      vi.advanceTimersByTime(5_000)
      await flush()
    })
    expect(calls).toBeGreaterThan(1)
    // Not from the mark again: from the cursor it stopped at.
    expect(api.personalAgentTimelineUpdatedSince.mock.calls[0]).toEqual([
      null,
      cursor,
      1,
      null,
    ])
  })
})

describe("PersonalAgentProvider, dispatch cards", () => {
  /**
   * A dispatch read is out (it will answer "running") when the dispatch
   * reports it finished. The change must not be lost behind the read in
   * flight: once that read lands, the dispatch is read again.
   */
  it("reads a dispatch again when it changed while a read was out", async () => {
    let answerFirst: (list: DispatchInfo[]) => void = () => {}
    api.personalAgentGet.mockResolvedValue(snapshot("here"))
    api.personalAgentTimeline.mockResolvedValue(
      page([
        row(3, "dispatch", "2026-11-04T10:00:00Z", {
          dispatch_id: 7,
          batch_id: 1,
        }),
      ])
    )
    api.personalAgentDispatches
      .mockImplementationOnce(
        () =>
          new Promise<DispatchInfo[]>((resolve) => {
            answerFirst = resolve
          })
      )
      .mockResolvedValue([dispatch(7, "completed")])

    render(
      <PersonalAgentProvider>
        <Probe onValue={keep} />
      </PersonalAgentProvider>
    )
    await act(flush)
    expect(api.personalAgentDispatches).toHaveBeenCalledTimes(1)

    // It finishes while the first read is still out.
    await act(async () => {
      bus.handler?.({ kind: "dispatch", id: 7 })
      await flush()
    })
    expect(api.personalAgentDispatches).toHaveBeenCalledTimes(1)

    // The first read lands, stale; the dispatch is read again.
    await act(async () => {
      answerFirst([dispatch(7, "running")])
      await flush()
    })
    expect(api.personalAgentDispatches).toHaveBeenCalledTimes(2)
    await act(flush)
    expect(ctx!.dispatchById.get(7)?.state).toBe("completed")
  })
})

describe("ViewedPersonalAgentProvider", () => {
  /** The page reads the assistant the roster picked; the sidebar keeps
   *  reading the primary's — and switching remounts nothing below. */
  it("hands the page the viewed assistant's store and keeps the primary's beside it", async () => {
    api.personalAgentGet.mockImplementation(async (bot: number | null) => ({
      ...snapshot("here"),
      agent: { id: bot ?? 1, name: bot == null ? "Nova" : "Reviewer" },
    }))
    api.personalAgentTimeline.mockResolvedValue(page([]))
    const seen: { page: Ctx | null; primary: Ctx | null; mounts: number } = {
      page: null,
      primary: null,
      mounts: 0,
    }
    function Reader() {
      const page = usePersonalAgent()
      const primary = usePrimaryAgent()
      useEffect(() => {
        seen.page = page
        seen.primary = primary
      })
      useEffect(() => {
        seen.mounts += 1
      }, [])
      return null
    }
    const tree = (viewBot: number | null) => (
      <PersonalAgentProvider>
        <ViewedPersonalAgentProvider viewBot={viewBot}>
          <Reader />
        </ViewedPersonalAgentProvider>
      </PersonalAgentProvider>
    )
    const { rerender } = render(tree(null))
    await act(flush)
    expect(seen.page!.botId).toBeNull()
    expect(seen.page!.snapshot?.agent?.name).toBe("Nova")
    rerender(tree(9))
    // Until its own store is read, the page waits: never the primary's.
    expect(seen.page!.botId).toBe(9)
    await act(flush)
    expect(seen.page!.snapshot?.agent?.name).toBe("Reviewer")
    expect(seen.primary!.botId).toBeNull()
    expect(seen.primary!.snapshot?.agent?.name).toBe("Nova")
    expect(api.personalAgentGet).toHaveBeenCalledWith(9)
    rerender(tree(null))
    expect(seen.page!.snapshot?.agent?.name).toBe("Nova")
    expect(seen.mounts).toBe(1)
  })
})
