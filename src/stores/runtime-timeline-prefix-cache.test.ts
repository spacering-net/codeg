import { afterEach, describe, expect, it } from "vitest"
import type { LiveMessage } from "@/contexts/acp-connections-context"
import type { DbConversationDetail, MessageTurn } from "@/lib/types"
import {
  getTimelineTurns,
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"

const CID = 42

function turn(
  id: string,
  role: "user" | "assistant",
  timestamp = "2026-07-19T00:00:00.000Z"
): MessageTurn {
  return { id, role, blocks: [{ type: "text", text: id }], timestamp }
}

function makeDetail(turns: MessageTurn[]): DbConversationDetail {
  return {
    summary: {
      id: CID,
      folder_id: 1,
      title: "t",
      title_locked: false,
      agent_type: "claude_code",
      status: "idle",
      kind: "regular",
      model: null,
      git_branch: null,
      external_id: null,
      message_count: turns.length,
      child_count: 0,
      created_at: "2026-07-19T00:00:00.000Z",
      updated_at: "2026-07-19T00:00:00.000Z",
      pinned_at: null,
    },
    turns,
  }
}

function seedSession(
  conversationId: number,
  overrides: Partial<
    ReturnType<
      typeof useConversationRuntimeStore.getState
    >["byConversationId"] extends Map<number, infer S>
      ? S
      : never
  >
) {
  const session = {
    conversationId,
    externalId: null,
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
    syncState: "idle" as const,
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
  }
  const prev = useConversationRuntimeStore.getState().byConversationId
  const next = new Map(prev)
  next.set(conversationId, session)
  useConversationRuntimeStore.setState({ byConversationId: next })
}

const liveMsg = (id: string, text: string): LiveMessage => ({
  id,
  role: "assistant",
  content: [{ type: "text", text }],
  startedAt: 1_752_000_000_000,
})

afterEach(() => {
  resetConversationRuntimeStore()
})

describe("timeline prefix cache across streaming batches", () => {
  it("keeps prefix entry references stable across SET_LIVE_MESSAGE batches; only the tail is rebuilt", () => {
    const detail = makeDetail([
      turn("u1", "user"),
      turn("a1", "assistant"),
      turn("u2", "user"),
    ])
    seedSession(CID, { detail, liveMessage: liveMsg("m1", "hel") })

    const first = getTimelineTurns(CID)
    expect(first.map((e) => e.turn.id)).toEqual([
      "u1",
      "a1",
      "u2",
      `live-${CID}-m1`,
    ])

    // Next 16ms batch: a fresh liveMessage object (same id, same startedAt,
    // more text) — the store swaps the session object, so the per-session
    // memo misses, but every prefix input is untouched.
    useConversationRuntimeStore
      .getState()
      .actions.setLiveMessage(CID, liveMsg("m1", "hello"), true)
    const second = getTimelineTurns(CID)

    expect(second).not.toBe(first)
    expect(second).toHaveLength(4)
    // Prefix entries: identical objects, not just equal content.
    expect(second[0]).toBe(first[0])
    expect(second[1]).toBe(first[1])
    expect(second[2]).toBe(first[2])
    // Streaming tail: rebuilt from the new liveMessage.
    expect(second[3]).not.toBe(first[3])
    expect(second[3].phase).toBe("streaming")
  })

  it("invalidates the prefix when a prefix input changes (promotion / refetch)", () => {
    const detail = makeDetail([turn("u1", "user"), turn("a1", "assistant")])
    seedSession(CID, { detail, liveMessage: liveMsg("m1", "x") })
    const before = getTimelineTurns(CID)

    // Promote a completed turn into localTurns (a prefix input) — same detail
    // object, so only the deps check can catch it.
    seedSession(CID, {
      detail,
      localTurns: [turn("a2", "assistant", "2026-07-19T00:01:00.000Z")],
      liveMessage: liveMsg("m1", "x"),
    })
    const after = getTimelineTurns(CID)

    expect(after.map((e) => e.turn.id)).toEqual([
      "u1",
      "a1",
      "a2",
      `live-${CID}-m1`,
    ])
    expect(before.map((e) => e.turn.id)).toEqual(["u1", "a1", `live-${CID}-m1`])

    // Refetch: a new detail object replaces the old cache key entirely.
    const refetched = makeDetail([
      turn("u1", "user"),
      turn("a1", "assistant"),
      turn("u3", "user", "2026-07-19T00:02:00.000Z"),
    ])
    seedSession(CID, { detail: refetched, liveMessage: null })
    expect(getTimelineTurns(CID).map((e) => e.turn.id)).toEqual([
      "u1",
      "a1",
      "u3",
    ])
  })

  it("resolves a live turn colliding with its promoted local copy via keep-LAST (slow path)", () => {
    // A premature COMPLETE_TURN left the in-flight turn in localTurns while
    // the same liveMessage is still streaming: both carry id `live-42-m1`.
    const detail = makeDetail([turn("u1", "user")])
    seedSession(CID, {
      detail,
      localTurns: [turn(`live-${CID}-m1`, "assistant")],
      liveMessage: liveMsg("m1", "streaming copy"),
    })

    const timeline = getTimelineTurns(CID)
    const copies = timeline.filter((e) => e.turn.id === `live-${CID}-m1`)
    expect(copies).toHaveLength(1)
    // keep-LAST: the streaming copy (appended after the local snapshot) wins.
    expect(copies[0].phase).toBe("streaming")
    expect(timeline.map((e) => e.turn.id)).toEqual(["u1", `live-${CID}-m1`])
  })

  it("keeps the FIRST copy of a user turn duplicated between persisted and optimistic", () => {
    const detail = makeDetail([turn("u1", "user"), turn("a1", "assistant")])
    seedSession(CID, {
      detail,
      optimisticTurns: [turn("u1", "user", "2026-07-19T00:03:00.000Z")],
    })

    const timeline = getTimelineTurns(CID)
    expect(timeline.map((e) => e.turn.id)).toEqual(["u1", "a1"])
    // The persisted copy (first) survives, in its original position.
    expect(timeline[0].phase).toBe("persisted")
    expect(timeline[0].turn.timestamp).toBe("2026-07-19T00:00:00.000Z")
  })

  it("does not leak a cached prefix across conversation ids sharing a detail object (migration)", () => {
    const detail = makeDetail([turn("u1", "user")])
    seedSession(CID, { detail })
    const timelineA = getTimelineTurns(CID)
    expect(timelineA[0].key).toBe(`persisted-${CID}-u1`)

    // Migration re-homes the same detail object under a new conversation id.
    const CID2 = CID + 1
    seedSession(CID2, { detail })
    const timelineB = getTimelineTurns(CID2)
    expect(timelineB[0].key).toBe(`persisted-${CID2}-u1`)
    expect(timelineB[0]).not.toBe(timelineA[0])
  })
})

describe("liveOwnsActiveTurn strips only the ACTIVE round", () => {
  it("keeps earlier rounds of a multi-round session visible while streaming", () => {
    // A work-task session runs work → rework → merge in ONE conversation and
    // is watched through the read-only viewer. Stripping "from the first
    // assistant turn" (the one-shot delegation-child rule) erased every
    // completed round for as long as the task streamed — the viewer showed
    // just the kickoff and the live reply.
    const detail = makeDetail([
      turn("u1", "user"),
      turn("a1", "assistant"),
      turn("u2", "user"),
      turn("a2", "assistant"),
      turn("u3", "user"),
    ])
    seedSession(CID, {
      detail,
      liveOwnsActiveTurn: true,
      liveMessage: liveMsg("m1", "working…"),
    })

    expect(getTimelineTurns(CID).map((e) => e.turn.id)).toEqual([
      "u1",
      "a1",
      "u2",
      "a2",
      "u3",
      `live-${CID}-m1`,
    ])
  })

  it("still drops the persisted copy of the reply being streamed", () => {
    // The DB caught up mid-stream: a3 is the partial persisted copy of the
    // very reply the live message is rendering — it must not double up.
    const detail = makeDetail([
      turn("u1", "user"),
      turn("a1", "assistant"),
      turn("u2", "user"),
      turn("a2", "assistant"),
    ])
    seedSession(CID, {
      detail,
      liveOwnsActiveTurn: true,
      liveMessage: liveMsg("m1", "half a rep"),
    })

    expect(getTimelineTurns(CID).map((e) => e.turn.id)).toEqual([
      "u1",
      "a1",
      "u2",
      `live-${CID}-m1`,
    ])
  })

  it("drops a lone persisted reply when no user turn has landed yet", () => {
    // Cold transcript (the agent CLI writes its JSONL asynchronously): there
    // is no user turn to anchor on, and the only assistant content that can
    // exist is the reply being streamed.
    const detail = makeDetail([turn("a1", "assistant")])
    seedSession(CID, {
      detail,
      liveOwnsActiveTurn: true,
      delegationKickoffText: "do the thing",
      liveMessage: liveMsg("m1", "on it"),
    })

    expect(getTimelineTurns(CID).map((e) => e.turn.id)).toEqual([
      `kickoff-${CID}`,
      `live-${CID}-m1`,
    ])
  })

  it("leaves a settled session's full history alone", () => {
    const detail = makeDetail([
      turn("u1", "user"),
      turn("a1", "assistant"),
      turn("u2", "user"),
      turn("a2", "assistant"),
    ])
    seedSession(CID, { detail, liveOwnsActiveTurn: true, liveMessage: null })

    expect(getTimelineTurns(CID).map((e) => e.turn.id)).toEqual([
      "u1",
      "a1",
      "u2",
      "a2",
    ])
  })
})
