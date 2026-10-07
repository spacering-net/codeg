/**
 * Coverage for the out-of-turn content notice — the pill that offers to
 * re-read the transcript after an agent ran a turn CODEG never started.
 *
 * The flag is armed from the wire (per streamed token, so idempotence is a
 * performance contract as much as a correctness one) and disarmed by the read
 * that covers it. The interesting half is the disarm: only a SUCCESSFUL detail
 * response has actually re-parsed the transcript, so a failed load must leave
 * the pill standing — it is the user's only route back to that content.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DbConversationDetail } from "@/lib/types"
import {
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
  type ConversationRuntimeSession,
} from "@/stores/conversation-runtime-store"

vi.mock("@/lib/api", () => ({
  getFolderConversation: vi.fn(),
  getFolderConversationTurns: vi.fn(),
}))

const { getFolderConversation } = await import("@/lib/api")
const mockGet = vi.mocked(getFolderConversation)

const CID = 42

function detail(): DbConversationDetail {
  return {
    summary: {
      id: CID,
      folder_id: 1,
      agent_type: "code_buddy",
      title: null,
      title_locked: false,
      status: "completed",
      kind: "regular",
      model: null,
      git_branch: null,
      external_id: "ext-1",
      message_count: 1,
      child_count: 0,
      created_at: new Date(1_700_000_000_000).toISOString(),
      updated_at: new Date(1_700_000_001_000).toISOString(),
      pinned_at: null,
    },
    turns: [
      {
        id: "turn-0",
        role: "assistant",
        blocks: [{ type: "text", text: "drained" }],
        timestamp: new Date(1_700_000_001_000).toISOString(),
      },
    ],
    session_stats: null,
    transcript_watermark: null,
    in_flight_user_turn_id: null,
    turns_offset: 0,
    turns_total: 1,
    assistant_turns_before_offset: 0,
    prefix_hash: null,
    uncovered_prefix_max_ts: null,
  }
}

function emptySession(conversationId: number): ConversationRuntimeSession {
  return {
    conversationId,
    externalId: "ext-1",
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
  }
}

function seed(overrides: Partial<ConversationRuntimeSession> = {}): void {
  useConversationRuntimeStore.setState({
    byConversationId: new Map([[CID, { ...emptySession(CID), ...overrides }]]),
  })
}

function session(): ConversationRuntimeSession | undefined {
  return useConversationRuntimeStore.getState().byConversationId.get(CID)
}

function actions() {
  return useConversationRuntimeStore.getState().actions
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  resetConversationRuntimeStore()
  mockGet.mockReset()
})

describe("markOutOfTurnContent", () => {
  it("arms the pill", () => {
    seed()
    actions().markOutOfTurnContent(CID)
    expect(session()?.pendingOutOfTurnContent).toBe(true)
  })

  it("is referentially idempotent once armed", () => {
    seed()
    actions().markOutOfTurnContent(CID)
    const armed = useConversationRuntimeStore.getState().byConversationId

    // Called once per streamed token for the whole drain: a repeat must not
    // allocate a new map/session, or every token re-renders the thread.
    actions().markOutOfTurnContent(CID)
    expect(useConversationRuntimeStore.getState().byConversationId).toBe(armed)
  })

  it("does not resurrect a session whose tab already closed", () => {
    resetConversationRuntimeStore()
    actions().markOutOfTurnContent(CID)
    expect(
      useConversationRuntimeStore.getState().byConversationId.has(CID)
    ).toBe(false)
  })
})

describe("disarming", () => {
  it("clears once the refetch it offers lands", async () => {
    seed({ pendingOutOfTurnContent: true })
    mockGet.mockResolvedValue(detail())

    actions().refetchDetail(CID, { preserveLive: true })
    await flush()

    expect(session()?.pendingOutOfTurnContent).toBe(false)
    expect(session()?.detail?.turns.map((t) => t.id)).toEqual(["turn-0"])
  })

  it("stays armed when the refetch fails", async () => {
    seed({ pendingOutOfTurnContent: true })
    mockGet.mockRejectedValue(new Error("transcript unreadable"))

    actions().refetchDetail(CID, { preserveLive: true })
    await flush()

    // Nothing was re-parsed, so the content is still unrendered and the pill
    // is the only way back to it.
    expect(session()?.detailError).toBe("transcript unreadable")
    expect(session()?.pendingOutOfTurnContent).toBe(true)
  })

  it("survives the draft→real row migration from either side", () => {
    const armedOnDraft = { ...emptySession(-9), pendingOutOfTurnContent: true }
    const plainTarget = emptySession(CID)
    useConversationRuntimeStore.setState({
      byConversationId: new Map([
        [-9, armedOnDraft],
        [CID, plainTarget],
      ]),
    })
    actions().migrateConversation(-9, CID)
    expect(session()?.pendingOutOfTurnContent).toBe(true)

    // And the other way round: the merge spreads `from` over `to`, so without
    // an explicit OR the target's own pill would be dropped on the floor.
    useConversationRuntimeStore.setState({
      byConversationId: new Map([
        [-9, emptySession(-9)],
        [CID, { ...emptySession(CID), pendingOutOfTurnContent: true }],
      ]),
    })
    actions().migrateConversation(-9, CID)
    expect(session()?.pendingOutOfTurnContent).toBe(true)
  })

  it("clears on any successful load, not just the one the pill triggered", async () => {
    seed({ pendingOutOfTurnContent: true })
    mockGet.mockResolvedValue(detail())

    // A cold open re-parses the same transcript, so it covers the same bytes.
    actions().fetchDetail(CID)
    await flush()

    expect(session()?.pendingOutOfTurnContent).toBe(false)
  })
})
