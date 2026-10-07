import { afterEach, describe, expect, it } from "vitest"
import type { LiveMessage } from "@/contexts/acp-connections-context"
import type { SessionStats } from "@/lib/types"
import {
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"

const CID = 42

// A complete runtime session (mirrors the store's internal `createEmptySession`)
// with distinct non-null references for the fields exercised here, seeded
// straight into the store.
function seedSession(sessionStats: SessionStats) {
  useConversationRuntimeStore.setState({
    byConversationId: new Map([
      [
        CID,
        {
          conversationId: CID,
          externalId: "sid-1",
          dbConversationId: null,
          detail: null,
          detailLoading: false,
          detailError: null,
          acpLoadError: null,
          localTurns: [],
          backgroundTurns: [],
          pendingBackgroundSettlements: [],
          optimisticTurns: [],
          liveMessage: null,
          syncState: "awaiting_persist",
          activeTurnToken: null,
          lastTurnOwned: false,
          liveOwnsActiveTurn: false,
          delegationKickoffText: null,
          sessionStats,
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

const liveMsg = (id: string): LiveMessage => ({
  id,
  role: "assistant",
  content: [],
  startedAt: 0,
})

// The two fields the keep-alive panel reads from its session via `useShallow`.
function panelSlice() {
  const s = useConversationRuntimeStore.getState().byConversationId.get(CID)
  return {
    externalId: s?.externalId ?? null,
    syncState: s?.syncState ?? "idle",
  }
}

// `sessionStats` is no longer part of the panel slice; the below-composer context
// indicator reads it per-conversation from this same store, so its reference
// stability across streaming is asserted separately here.
function sessionStatsOf() {
  return (
    useConversationRuntimeStore.getState().byConversationId.get(CID)
      ?.sessionStats ?? null
  )
}

// The keep-alive conversation panel (`ConversationTabView`) subscribes to a
// `useShallow` slice of {externalId, syncState} from its runtime session — NOT
// the whole session object. The live-message sink rewrites the session object on
// every streaming batch (~60/s, via SET_LIVE_MESSAGE); a whole-object selector
// would re-render the panel per token. These tests encode the store invariant
// that narrowing depends on: SET_LIVE_MESSAGE replaces the session object (so the
// OLD whole-object selector churned) while preserving the references of those two
// fields (so the slice is Object.is-stable and `useShallow` bails → no re-render)
// — and that a real change to one still propagates (no over-suppression).
// `sessionStats` (read per-conversation by the context indicator) must survive
// streaming with the same reference too, so that read stays inert to live tokens.
describe("runtime session panel slice is decoupled from live-message streaming", () => {
  afterEach(() => resetConversationRuntimeStore())

  it("replaces the session object but keeps the panel slice + sessionStats stable across a streaming batch", () => {
    const stats: SessionStats = { total_usage: null, total_duration_ms: 0 }
    seedSession(stats)

    const before = useConversationRuntimeStore
      .getState()
      .byConversationId.get(CID)
    const beforeSlice = panelSlice()
    const beforeStats = sessionStatsOf()

    // A streaming batch lands: the connection sink writes liveMessage (isLive).
    useConversationRuntimeStore
      .getState()
      .actions.setLiveMessage(CID, liveMsg("m1"), true)

    const after = useConversationRuntimeStore
      .getState()
      .byConversationId.get(CID)
    // The session OBJECT was replaced — exactly why a whole-object selector
    // re-rendered the keep-alive panel on every token.
    expect(after).not.toBe(before)
    expect(after?.liveMessage).not.toBeNull()

    // ...but every field the panel's narrow slice reads kept its identity, so
    // `useShallow` shallow-compares equal and the panel does NOT re-render.
    const afterSlice = panelSlice()
    expect(afterSlice.externalId).toBe(beforeSlice.externalId)
    expect(afterSlice.syncState).toBe(beforeSlice.syncState)
    // sessionStats (read per-conversation by the context indicator) is likewise
    // reference-stable across the streaming batch.
    expect(sessionStatsOf()).toBe(beforeStats)
    expect(sessionStatsOf()).toBe(stats)
  })

  it("still propagates a real change to a slice field (no over-suppression)", () => {
    const stats: SessionStats = { total_usage: null, total_duration_ms: 0 }
    seedSession(stats)
    const beforeSlice = panelSlice()
    expect(beforeSlice.syncState).toBe("awaiting_persist")

    // A genuine syncState transition must change the slice so the panel updates.
    useConversationRuntimeStore.getState().actions.setSyncState(CID, "idle")

    const afterSlice = panelSlice()
    expect(afterSlice.syncState).toBe("idle")
    expect(afterSlice.syncState).not.toBe(beforeSlice.syncState)
    // Unrelated fields keep their identity across the syncState change.
    expect(afterSlice.externalId).toBe(beforeSlice.externalId)
    expect(sessionStatsOf()).toBe(stats)
  })
})
