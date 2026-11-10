import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { LiveMessage } from "@/contexts/acp-connections-context"
import type { DbConversationDetail, MessageTurn } from "@/lib/types"
import {
  type ConversationRuntimeSession,
  resetConversationRuntimeStore,
  TAIL_TURNS_DEFAULT,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"
import {
  DETAIL_RETRY_DELAYS_MS,
  useConversationDetail,
} from "./use-conversation-detail"

// The runtime store calls the transport directly; the visibility-gating tests
// below assert on the call itself, so the transport is stubbed out.
vi.mock("@/lib/api", () => ({
  getFolderConversation: vi.fn(),
  getFolderConversationTurns: vi.fn(),
}))

const { getFolderConversation } = await import("@/lib/api")
const mockGet = vi.mocked(getFolderConversation)

const CID = 77

function seedSession(
  detail: DbConversationDetail | null,
  overrides: Partial<ConversationRuntimeSession> = {}
) {
  useConversationRuntimeStore.setState({
    byConversationId: new Map([
      [
        CID,
        {
          conversationId: CID,
          externalId: null,
          dbConversationId: null,
          detail,
          detailLoading: false,
          detailError: null,
          acpLoadError: null,
          localTurns: [],
          backgroundTurns: [],
          pendingBackgroundSettlements: [],
          pendingCancelledTurnReports: null,
          optimisticTurns: [],
          liveMessage: null,
          syncState: "idle",
          activeTurnToken: null,
          lastTurnOwned: false,
          liveOwnsActiveTurn: false,
          delegationKickoffText: null,
          sessionStats: null,
          historyAssistantBaseline: null,
          batchBoundaryIndex: null,
          batchBoundaryPrefixHash: null,
          loadingOlderTurns: false,
          olderTurnsPrependEpoch: 0,
          pendingOutOfTurnContent: false,
          pendingCleanup: false,
          ...overrides,
        },
      ],
    ]),
  })
}

const makeDetail = (): DbConversationDetail =>
  ({ summary: {}, turns: [] }) as unknown as DbConversationDetail

const liveMsg = (id: string): LiveMessage => ({
  id,
  role: "assistant",
  content: [],
  startedAt: 0,
})

const turn = (role: "user" | "assistant"): MessageTurn =>
  ({
    id: `${role}-1`,
    role,
    blocks: [],
    timestamp: "2026-10-10T00:00:00Z",
  }) as unknown as MessageTurn

// `useConversationDetail` is one of the two runtime-store subscriptions the
// keep-alive conversation panel (`ConversationTabView`) makes for its own
// session. The live-message sink replaces the session object on every streaming
// batch (~60/s via SET_LIVE_MESSAGE), so a whole-session subscription here would
// re-render the panel on every token. The hook now subscribes to a narrow
// `useShallow` slice — these tests exercise the REAL render path (not just the
// store invariant) to prove it is decoupled from streaming yet still reacts to a
// genuine detail change. `enabled: false` isolates the subscription from the
// auto-fetch effect.
describe("useConversationDetail streaming decoupling", () => {
  // Reset can fire a store update while the hook is still mounted (before RTL
  // cleanup); wrap it in act to avoid an "update not wrapped in act" warning.
  afterEach(() => act(() => resetConversationRuntimeStore()))

  it("does NOT re-render when a streaming batch replaces the session object", () => {
    seedSession(makeDetail())
    let renders = 0
    const { result } = renderHook(() => {
      renders++
      return useConversationDetail(CID, { enabled: false })
    })
    const mounted = renders
    const first = result.current

    act(() => {
      useConversationRuntimeStore
        .getState()
        .actions.setLiveMessage(CID, liveMsg("m1"), true)
    })

    // A streaming batch replaced the session object but touched only
    // liveMessage; none of the sliced detail fields changed → no re-render.
    expect(renders).toBe(mounted)
    expect(result.current).toBe(first)
  })

  it("re-renders and surfaces the new detail when detail actually changes", () => {
    seedSession(null)
    let renders = 0
    const { result } = renderHook(() => {
      renders++
      return useConversationDetail(CID, { enabled: false })
    })
    const mounted = renders
    expect(result.current.detail).toBeNull()

    // A real detail transition (fetch success, etc.) must re-render consumers.
    const nextDetail = makeDetail()
    act(() => seedSession(nextDetail))

    expect(renders).toBe(mounted + 1)
    expect(result.current.detail).toBe(nextDetail)
  })
})

// The workspace keeps every open tab's view MOUNTED (that is what preserves a
// background session's stream and scroll state), so the auto-fetch has to be
// gated on visibility rather than on mount. Restoring a workspace with N open
// tabs used to issue N concurrent detail fetches — each a tail window of up to
// TAIL_TURNS_DEFAULT turns, i.e. tens of MB across a large tab set — before the
// user had looked at a single one of them. A hidden view must therefore hold
// its fetch, and fire it on the render that flips it visible.
describe("useConversationDetail visibility gating", () => {
  afterEach(() => {
    // Unmount BEFORE the reset: a still-mounted enabled hook answers the reset
    // by fetching again, and that in-flight session would leak into the next
    // test (RTL's own cleanup runs after this hook).
    cleanup()
    act(() => resetConversationRuntimeStore())
    mockGet.mockReset()
  })

  it("holds the fetch while the view is off screen", () => {
    const { result } = renderHook(() =>
      useConversationDetail(CID, { enabled: false })
    )

    expect(mockGet).not.toHaveBeenCalled()
    expect(result.current.detail).toBeNull()
  })

  it("fetches the default tail window once the view becomes visible", () => {
    // Never resolves on purpose: this test is about WHEN the request is
    // issued, and a pending promise keeps the resolution-driven store write
    // (which would need its own act scope) out of the picture.
    mockGet.mockReturnValue(new Promise<DbConversationDetail>(() => {}))

    const { rerender } = renderHook(
      ({ visible }: { visible: boolean }) =>
        useConversationDetail(CID, { enabled: visible }),
      { initialProps: { visible: false } }
    )
    expect(mockGet).not.toHaveBeenCalled()

    act(() => {
      rerender({ visible: true })
    })

    expect(mockGet).toHaveBeenCalledTimes(1)
    expect(mockGet).toHaveBeenCalledWith(CID, { tailTurns: TAIL_TURNS_DEFAULT })
  })

  // A hidden tab is not session-less: the panel's mount effects (the runtime
  // claim + `setPendingCleanup`) materialize its runtime session while the
  // fetch waits. The render that shows it therefore reads a session with no
  // detail and nothing in flight — and that is the render the panel's
  // auto-connect gate is taken from. Reporting it as settled let the connect
  // out with `sessionId: undefined`; it has to read as loading already.
  it("reports loading on the very render that first shows the view", () => {
    mockGet.mockReturnValue(new Promise<DbConversationDetail>(() => {}))
    act(() => {
      useConversationRuntimeStore
        .getState()
        .actions.setPendingCleanup(CID, false)
    })
    const seen: Array<{ visible: boolean; loading: boolean; detail: boolean }> =
      []
    const { rerender } = renderHook(
      ({ visible }: { visible: boolean }) => {
        const view = useConversationDetail(CID, { enabled: visible })
        seen.push({
          visible,
          loading: view.loading,
          detail: view.detail != null,
        })
        return view
      },
      { initialProps: { visible: false } }
    )
    expect(mockGet).not.toHaveBeenCalled()

    act(() => {
      rerender({ visible: true })
    })

    const shown = seen.filter((render) => render.visible)
    expect(shown.length).toBeGreaterThan(0)
    expect(shown).toEqual(
      shown.map(() => ({ visible: true, loading: true, detail: false }))
    )
    expect(mockGet).toHaveBeenCalledTimes(1)
  })

  // The pending-fetch half of `loading` must follow `fetchDetail`'s own skip
  // rule exactly: a session an ongoing turn holds is never fetched, so
  // reporting it as loading would hold the panel's connect gate shut forever.
  it.each<[string, Partial<ConversationRuntimeSession>]>([
    ["a live stream", { liveMessage: liveMsg("m1") }],
    ["an optimistic prompt", { optimisticTurns: [turn("user")] }],
    ["promoted local turns", { localTurns: [turn("assistant")] }],
  ])(
    "does not report a fetch it will not make as loading (%s)",
    (_holder, holds) => {
      act(() => seedSession(null, holds))

      const { result } = renderHook(() => useConversationDetail(CID))

      expect(result.current.loading).toBe(false)
      expect(result.current.detail).toBeNull()
      expect(mockGet).not.toHaveBeenCalled()
    }
  )
})

// A failed fetch leaves no detail and nothing in flight — exactly what the
// auto-fetch keys on — so it used to be re-requested on the very next render,
// as fast as the transport could fail, with the error flickering in and out.
describe("useConversationDetail after a failed fetch", () => {
  // Rejects every call up to a cap, then never settles: a regression back to
  // the hot loop then fails the call-count assertions instead of spinning the
  // worker out of memory.
  function failEveryFetch(message: string) {
    let calls = 0
    mockGet.mockImplementation(() => {
      calls += 1
      return calls <= 50
        ? Promise.reject(new Error(message))
        : new Promise<DbConversationDetail>(() => {})
    })
  }

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    act(() => resetConversationRuntimeStore())
    mockGet.mockReset()
  })

  it("leaves the failure on screen instead of re-requesting it at once", async () => {
    failEveryFetch("unreadable transcript")

    const { result } = renderHook(() => useConversationDetail(CID))
    for (let round = 0; round < 5; round++) {
      await act(async () => {})
    }

    expect(mockGet).toHaveBeenCalledTimes(1)
    expect(result.current.error).toBe("unreadable transcript")
    expect(result.current.loading).toBe(false)
  })

  it("retries on a growing delay, then keeps retrying at the last one", async () => {
    vi.useFakeTimers()
    failEveryFetch("server down")

    renderHook(() => useConversationDetail(CID))
    await act(async () => {})
    expect(mockGet).toHaveBeenCalledTimes(1)

    const last = DETAIL_RETRY_DELAYS_MS[DETAIL_RETRY_DELAYS_MS.length - 1]
    const schedule = [...DETAIL_RETRY_DELAYS_MS, last, last]
    for (const [step, delay] of schedule.entries()) {
      await act(async () => {
        vi.advanceTimersByTime(delay - 1)
      })
      expect(mockGet).toHaveBeenCalledTimes(step + 1)
      await act(async () => {
        vi.advanceTimersByTime(1)
      })
      expect(mockGet).toHaveBeenCalledTimes(step + 2)
    }
  })

  it("starts the schedule over once a detail has loaded", async () => {
    vi.useFakeTimers()
    mockGet
      .mockRejectedValueOnce(new Error("blip"))
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValueOnce(makeDetail())
      .mockRejectedValueOnce(new Error("blip again"))
      .mockReturnValue(new Promise<DbConversationDetail>(() => {}))

    renderHook(() => useConversationDetail(CID))
    await act(async () => {})
    await act(async () => {
      vi.advanceTimersByTime(DETAIL_RETRY_DELAYS_MS[0])
    })
    await act(async () => {
      vi.advanceTimersByTime(DETAIL_RETRY_DELAYS_MS[1])
    })
    expect(mockGet).toHaveBeenCalledTimes(3)

    // The session goes away under the mounted view (released and recreated),
    // so the view fetches afresh — and that fetch fails again.
    act(() => {
      useConversationRuntimeStore.getState().actions.removeConversation(CID)
    })
    await act(async () => {})
    expect(mockGet).toHaveBeenCalledTimes(4)

    await act(async () => {
      vi.advanceTimersByTime(DETAIL_RETRY_DELAYS_MS[0])
    })
    expect(mockGet).toHaveBeenCalledTimes(5)
  })

  it("lands the detail when a retry succeeds", async () => {
    vi.useFakeTimers()
    const detail = makeDetail()
    mockGet
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValueOnce(detail)

    const { result } = renderHook(() => useConversationDetail(CID))
    await act(async () => {})
    expect(result.current.error).toBe("blip")

    await act(async () => {
      vi.advanceTimersByTime(DETAIL_RETRY_DELAYS_MS[0])
    })

    expect(mockGet).toHaveBeenCalledTimes(2)
    expect(result.current.detail).toBe(detail)
    expect(result.current.error).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  it("holds a pending retry while the view is hidden", async () => {
    vi.useFakeTimers()
    failEveryFetch("server down")

    const { rerender } = renderHook(
      ({ visible }: { visible: boolean }) =>
        useConversationDetail(CID, { enabled: visible }),
      { initialProps: { visible: true } }
    )
    await act(async () => {})
    act(() => {
      rerender({ visible: false })
    })
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    expect(mockGet).toHaveBeenCalledTimes(1)

    act(() => {
      rerender({ visible: true })
    })
    await act(async () => {
      vi.advanceTimersByTime(DETAIL_RETRY_DELAYS_MS[0])
    })
    expect(mockGet).toHaveBeenCalledTimes(2)
  })
})
