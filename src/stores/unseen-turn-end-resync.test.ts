/**
 * Coverage for a turn that ended while this client was not receiving its events
 * (#386): a phone puts the page in the background mid-reply, the reply finishes,
 * the phone comes back. The re-attach learns the turn is over from a snapshot (or
 * finds the connection gone), the panel settles the turn on what it has — the
 * head of the reply, from before the socket dropped — and, before this fix,
 * nothing ever loaded the rest: only reloading the page did.
 *
 * The connections layer marks such a session (`markTurnEndUnseen`); the store's
 * `completeTurn` then reads the reply from the transcript. These tests pin:
 *   - an ordinary (watched) turn end still never reads the transcript;
 *   - a marked one replaces the promoted head with the transcript's reply, only
 *     once the transcript holds that reply, and never shows less than before;
 *   - a follow-up turn that started meanwhile is left alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DbConversationDetail, MessageTurn } from "@/lib/types"
import type { LiveMessage } from "@/contexts/acp-connections-context"
import {
  getTimelineTurns,
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
  type ConversationRuntimeSession,
} from "@/stores/conversation-runtime-store"

vi.mock("@/lib/api", () => ({
  getFolderConversation: vi.fn(),
}))

const { getFolderConversation } = await import("@/lib/api")
const mockGet = vi.mocked(getFolderConversation)

// A draft-started tab: virtual runtime key, real row bound separately.
const CID = -7
const DB_ID = 42
const SESSION = "sess-1"

function userTurn(id: string, text: string): MessageTurn {
  return { id, role: "user", blocks: [{ type: "text", text }], timestamp: "" }
}

function assistantTurn(id: string, text: string): MessageTurn {
  return {
    id,
    role: "assistant",
    blocks: [{ type: "text", text }],
    timestamp: "",
  }
}

function detail(
  turns: MessageTurn[],
  inFlightUserTurnId: string | null = null
): DbConversationDetail {
  return {
    summary: {
      id: DB_ID,
      folder_id: 1,
      agent_type: "claude_code",
      title: null,
      title_locked: false,
      status: "completed",
      kind: "regular",
      model: null,
      git_branch: null,
      external_id: SESSION,
      message_count: turns.length,
      child_count: 0,
      created_at: "2026-10-20T00:00:00.000Z",
      updated_at: "2026-10-20T00:00:00.000Z",
      pinned_at: null,
    },
    turns,
    session_stats: null,
    transcript_watermark: null,
    in_flight_user_turn_id: inFlightUserTurnId,
  }
}

function live(id: string, text: string): LiveMessage {
  return {
    id,
    role: "assistant",
    content: [{ type: "text", text }],
    startedAt: 0,
  }
}

/**
 * The owner's tab while the reply streams: its prompt waiting to persist, and
 * the head of the reply the socket delivered before it dropped.
 */
function seedStreamingOwner(
  overrides: Partial<ConversationRuntimeSession> = {}
): void {
  const session: ConversationRuntimeSession = {
    conversationId: CID,
    externalId: SESSION,
    dbConversationId: DB_ID,
    detail: null,
    detailLoading: false,
    detailError: null,
    acpLoadError: null,
    localTurns: [],
    backgroundTurns: [],
    pendingBackgroundSettlements: [],
    pendingCancelledTurnReports: null,
    optimisticTurns: [userTurn("local-u1", "write it")],
    liveMessage: live("lm-1", "Line 1. Line 2. "),
    syncState: "awaiting_persist",
    activeTurnToken: "tok-1",
    lastTurnOwned: false,
    liveOwnsActiveTurn: false,
    delegationKickoffText: null,
    sessionStats: null,
    historyAssistantBaseline: 0,
    batchBoundaryIndex: 0,
    batchBoundaryPrefixHash: null,
    loadingOlderTurns: false,
    olderTurnsPrependEpoch: 0,
    pendingOutOfTurnContent: false,
    pendingCleanup: false,
    ...overrides,
  }
  useConversationRuntimeStore.setState({
    byConversationId: new Map([[CID, session]]),
    conversationIdByExternalId: new Map([[SESSION, CID]]),
  })
}

const actions = () => useConversationRuntimeStore.getState().actions
const session = () =>
  useConversationRuntimeStore.getState().byConversationId.get(CID)
const texts = () =>
  getTimelineTurns(CID).map((item) =>
    item.turn.blocks
      .map((b) => (b.type === "text" ? b.text : `[${b.type}]`))
      .join("")
  )

const FULL_REPLY = "Line 1. Line 2. Line 3. Line 4. END"
const persisted = () =>
  detail([userTurn("p-u1", "write it"), assistantTurn("p-a1", FULL_REPLY)])

beforeEach(() => {
  resetConversationRuntimeStore()
  mockGet.mockReset()
  vi.useFakeTimers()
})

afterEach(() => {
  resetConversationRuntimeStore()
  vi.useRealTimers()
})

describe("a turn that ended while this client was away", () => {
  it("keeps the head on screen, then replaces it with the reply from the transcript", async () => {
    seedStreamingOwner()
    mockGet.mockResolvedValue(persisted())

    actions().markTurnEndUnseen(SESSION)
    actions().completeTurn(CID)

    // Settled at once on what arrived — no blank reply while the read runs.
    expect(texts()).toEqual(["write it", "Line 1. Line 2. "])
    expect(session()?.detailLoading).toBe(false)
    expect(mockGet).toHaveBeenCalledWith(DB_ID, { tailTurns: 120 })

    await vi.advanceTimersByTimeAsync(0)

    // The reply as the transcript has it, exactly once.
    expect(texts()).toEqual(["write it", FULL_REPLY])
    expect(session()?.localTurns).toEqual([])
    expect(session()?.syncState).toBe("idle")
    // Read once, nothing left to poll for.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mockGet).toHaveBeenCalledTimes(1)
  })

  it("leaves a turn whose end this client watched alone: no transcript read", async () => {
    seedStreamingOwner()

    actions().completeTurn(CID)
    await vi.advanceTimersByTimeAsync(30_000)

    expect(mockGet).not.toHaveBeenCalled()
    expect(texts()).toEqual(["write it", "Line 1. Line 2. "])
  })

  it("marks only a session that holds a turn to settle", async () => {
    // Idle, nothing in the live buffers: it did not stream the turn that ended.
    seedStreamingOwner({
      optimisticTurns: [],
      liveMessage: null,
      syncState: "idle",
    })
    actions().markTurnEndUnseen(SESSION)

    actions().completeTurn(CID)
    await vi.advanceTimersByTimeAsync(30_000)

    expect(mockGet).not.toHaveBeenCalled()
  })

  it("waits for the transcript to hold the reply before taking it", async () => {
    seedStreamingOwner()
    // The reconnect landed as the turn ended: the agent has written the prompt
    // but not yet the reply.
    mockGet
      .mockResolvedValueOnce(detail([userTurn("p-u1", "write it")]))
      .mockResolvedValueOnce(persisted())

    actions().markTurnEndUnseen(SESSION)
    actions().completeTurn(CID)
    await vi.advanceTimersByTimeAsync(0)

    // Not taken: it would have put the prompt alone where the head was.
    expect(texts()).toEqual(["write it", "Line 1. Line 2. "])

    await vi.advanceTimersByTimeAsync(500)
    expect(mockGet).toHaveBeenCalledTimes(2)
    expect(texts()).toEqual(["write it", FULL_REPLY])
  })

  it("does not take a transcript that has not recorded the round at all", async () => {
    // One earlier round of history; this round starts at index 2.
    const history = [userTurn("p-u0", "hi"), assistantTurn("p-a0", "hello")]
    seedStreamingOwner({ detail: detail(history), batchBoundaryIndex: 2 })
    mockGet
      .mockResolvedValueOnce(detail(history))
      .mockResolvedValueOnce(
        detail([
          ...history,
          userTurn("p-u1", "write it"),
          assistantTurn("p-a1", FULL_REPLY),
        ])
      )

    actions().markTurnEndUnseen(SESSION)
    actions().completeTurn(CID)
    await vi.advanceTimersByTimeAsync(0)

    // Ends on a reply, but the PREVIOUS round's: taking it would drop this one.
    expect(texts()).toEqual(["hi", "hello", "write it", "Line 1. Line 2. "])

    await vi.advanceTimersByTimeAsync(500)
    expect(texts()).toEqual(["hi", "hello", "write it", FULL_REPLY])
  })

  it("does not take a read that has an earlier round of the batch but not the one that ended", async () => {
    // Round one ended while this client watched it and is still in
    // `localTurns`; round two ended while it was away. The batch starts at 0.
    seedStreamingOwner({
      localTurns: [
        userTurn("local-u1", "first"),
        assistantTurn("local-a1", "reply one"),
      ],
      optimisticTurns: [userTurn("local-u2", "second")],
      liveMessage: live("lm-2", "Two 1. "),
    })
    mockGet
      .mockResolvedValueOnce(
        detail([userTurn("p-u1", "first"), assistantTurn("p-a1", "reply one")])
      )
      .mockResolvedValueOnce(
        detail([
          userTurn("p-u1", "first"),
          assistantTurn("p-a1", "reply one"),
          userTurn("p-u2", "second"),
          assistantTurn("p-a2", "Two 1. Two 2. END"),
        ])
      )

    actions().markTurnEndUnseen(SESSION)
    actions().completeTurn(CID)
    await vi.advanceTimersByTimeAsync(0)

    // Ends on a reply inside the batch, but round one's: taking it would drop
    // round two's prompt and head.
    expect(texts()).toEqual(["first", "reply one", "second", "Two 1. "])

    await vi.advanceTimersByTimeAsync(500)
    expect(texts()).toEqual([
      "first",
      "reply one",
      "second",
      "Two 1. Two 2. END",
    ])
  })

  it("takes the reply of a viewer that attached mid-turn, whose prompt was already history", async () => {
    // The prompt was on disk when this viewer attached, so its batch starts
    // AFTER it (index 1) and holds the reply alone.
    seedStreamingOwner({
      detail: detail([userTurn("p-u1", "write it")], "p-u1"),
      batchBoundaryIndex: 1,
      optimisticTurns: [],
      syncState: "idle",
    })
    mockGet.mockResolvedValue(persisted())

    actions().markTurnEndUnseen(SESSION)
    actions().completeTurn(CID)
    await vi.advanceTimersByTimeAsync(0)

    expect(texts()).toEqual(["write it", FULL_REPLY])
    expect(mockGet).toHaveBeenCalledTimes(1)
  })

  it("with no batch start known, waits for the ended round's own prompt", async () => {
    seedStreamingOwner({ batchBoundaryIndex: null })
    mockGet
      // An older round's reply ends this read: not the round that ended.
      .mockResolvedValueOnce(
        detail([userTurn("p-u0", "hi"), assistantTurn("p-a0", "hello")])
      )
      .mockResolvedValueOnce(
        detail([
          userTurn("p-u0", "hi"),
          assistantTurn("p-a0", "hello"),
          userTurn("p-u1", "write it"),
          assistantTurn("p-a1", FULL_REPLY),
        ])
      )

    actions().markTurnEndUnseen(SESSION)
    actions().completeTurn(CID)
    await vi.advanceTimersByTimeAsync(0)
    expect(texts()).toEqual(["write it", "Line 1. Line 2. "])

    await vi.advanceTimersByTimeAsync(500)
    expect(texts()).toEqual(["hi", "hello", "write it", FULL_REPLY])
  })

  it("keeps the head when the transcript never catches up", async () => {
    seedStreamingOwner()
    mockGet.mockResolvedValue(detail([userTurn("p-u1", "write it")]))

    actions().markTurnEndUnseen(SESSION)
    actions().completeTurn(CID)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(mockGet).toHaveBeenCalledTimes(6)
    expect(texts()).toEqual(["write it", "Line 1. Line 2. "])
  })

  it("keeps a follow-up that started before the read landed", async () => {
    seedStreamingOwner()
    let resolveRead: (d: DbConversationDetail) => void = () => {}
    mockGet.mockImplementationOnce(
      () =>
        new Promise<DbConversationDetail>((resolve) => {
          resolveRead = resolve
        })
    )

    actions().markTurnEndUnseen(SESSION)
    actions().completeTurn(CID)
    // The queued follow-up goes out the moment the turn settles.
    actions().appendOptimisticTurn(CID, userTurn("local-u2", "and more"), "t2")
    actions().setLiveMessage(CID, live("lm-2", "More 1. "), true)

    // The backend reports the follow-up as the turn in flight, its prompt
    // stamped with the id this client sent it under.
    resolveRead(
      detail(
        [
          userTurn("p-u1", "write it"),
          assistantTurn("p-a1", FULL_REPLY),
          userTurn("local-u2", "and more"),
        ],
        "local-u2"
      )
    )
    await vi.advanceTimersByTimeAsync(0)

    expect(texts()).toEqual(["write it", FULL_REPLY, "and more", "More 1. "])
    expect(session()?.syncState).toBe("awaiting_persist")
    expect(session()?.liveMessage?.id).toBe("lm-2")
  })

  it("stops when a load already replaced what the promotion left", async () => {
    seedStreamingOwner()
    let resolveFirst: (d: DbConversationDetail) => void = () => {}
    mockGet
      .mockImplementationOnce(
        () =>
          new Promise<DbConversationDetail>((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockResolvedValueOnce(persisted())

    actions().markTurnEndUnseen(SESSION)
    actions().completeTurn(CID)
    // A reload the user asked for lands first.
    actions().refetchDetail(CID)
    await vi.advanceTimersByTimeAsync(0)
    expect(texts()).toEqual(["write it", FULL_REPLY])

    resolveFirst(detail([userTurn("p-u1", "write it")]))
    await vi.advanceTimersByTimeAsync(30_000)

    expect(mockGet).toHaveBeenCalledTimes(2)
    expect(texts()).toEqual(["write it", FULL_REPLY])
  })

  it("stops polling once the conversation is closed", async () => {
    seedStreamingOwner()
    mockGet.mockResolvedValue(detail([userTurn("p-u1", "write it")]))

    actions().markTurnEndUnseen(SESSION)
    actions().completeTurn(CID)
    await vi.advanceTimersByTimeAsync(0)
    actions().removeConversation(CID)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(mockGet).toHaveBeenCalledTimes(1)
    expect(session()).toBeUndefined()
  })
})
