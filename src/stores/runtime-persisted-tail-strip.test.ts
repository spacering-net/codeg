/**
 * The live persisted-tail strip removes the persisted copy of the reply that is
 * being streamed, because the live stream re-shows it. A `system` turn is the
 * one thing back there that has no live counterpart.
 *
 * Claude writes the post-compaction continuation summary as a `system` turn, and
 * an AUTOMATIC compaction lands it mid-turn — so stripping it hid the summary
 * for the whole remainder of the turn, then produced it out of nowhere when the
 * conversation was reopened.
 */

import { afterEach, describe, expect, it } from "vitest"

import type { DbConversationDetail, MessageTurn, TurnRole } from "@/lib/types"
import {
  getTimelineTurns,
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"

const CID = 91

function turn(id: string, role: TurnRole): MessageTurn {
  return {
    id,
    role,
    blocks: [{ type: "text", text: id }],
    timestamp: "2026-09-05T00:00:00.000Z",
  }
}

function seed(turns: MessageTurn[]) {
  const detail: DbConversationDetail = {
    summary: {
      id: CID,
      folder_id: 1,
      title: "t",
      title_locked: false,
      agent_type: "claude_code",
      status: "in_progress",
      kind: "regular",
      model: null,
      git_branch: null,
      external_id: null,
      message_count: turns.length,
      child_count: 0,
      created_at: "2026-09-05T00:00:00.000Z",
      updated_at: "2026-09-05T00:00:00.000Z",
      pinned_at: null,
    },
    turns,
    in_flight_user_turn_id: null,
  }
  const next = new Map(useConversationRuntimeStore.getState().byConversationId)
  next.set(CID, {
    conversationId: CID,
    externalId: null,
    dbConversationId: null,
    detail,
    detailLoading: false,
    detailError: null,
    acpLoadError: null,
    // A promoted reply in hand is what arms the strip.
    localTurns: [turn("live-reply", "assistant")],
    backgroundTurns: [],
    pendingBackgroundSettlements: [],
    optimisticTurns: [],
    liveMessage: null,
    syncState: "idle" as const,
    activeTurnToken: null,
    lastTurnOwned: false,
    liveOwnsActiveTurn: true,
    delegationKickoffText: null,
    sessionStats: null,
    historyAssistantBaseline: null,
    batchBoundaryIndex: null,
    batchBoundaryPrefixHash: null,
    loadingOlderTurns: false,
    olderTurnsPrependEpoch: 0,
    pendingOutOfTurnContent: false,
    pendingCleanup: false,
  })
  useConversationRuntimeStore.setState({ byConversationId: next })
}

const timelineIds = () => getTimelineTurns(CID).map((t) => t.turn.id)

afterEach(() => {
  resetConversationRuntimeStore()
})

describe("persisted-tail strip", () => {
  it("keeps a system turn written after the in-flight prompt", () => {
    seed([
      turn("u1", "user"),
      turn("a1", "assistant"),
      turn("compaction", "assistant"),
      turn("continuation", "system"),
    ])
    expect(timelineIds()).toEqual(["u1", "continuation", "live-reply"])
  })

  it("still strips the persisted copy of the streaming reply", () => {
    seed([turn("u1", "user"), turn("a1", "assistant")])
    expect(timelineIds()).toEqual(["u1", "live-reply"])
  })

  it("keeps a system turn even with no user turn to anchor on", () => {
    seed([turn("a1", "assistant"), turn("continuation", "system")])
    expect(timelineIds()).toEqual(["continuation", "live-reply"])
  })
})
