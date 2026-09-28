import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import type { LiveMessage } from "@/contexts/acp-connections-context"
import type { DbConversationDetail } from "@/lib/types"
import {
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"
import { useConversationDetail } from "./use-conversation-detail"

const CID = 77

function seedSession(detail: DbConversationDetail | null) {
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
