/**
 * A persisted transcript of a conversation that is STILL RUNNING must not paint
 * its unfinished tool calls as completed.
 *
 * The failing surface is a viewer that renders the persisted transcript without
 * owning the live stream — the work-task 查看会话 dialog when its attach missed,
 * or a cross-client reader. The adapter's rule for a `tool_use` with no
 * `tool_result` is "the conversation already ended, so it completed", which is
 * false there; a `get_delegation_status` poll blocking on its sub-agent then
 * shows a green ✓ for the entire wait (measured up to 30 minutes on a
 * `wait_ms: 0` poll).
 *
 * The store marks those calls from the backend's `in_flight_user_turn_id` — an
 * affirmative "a turn is running on this connection", never an inference from
 * missing output (an empty result still writes a `tool_result`).
 *
 * The same marker also flags the turns themselves (`isInFlightRound`), which is
 * what tells the render layer that a "persisted" reply is not finished. That
 * flag is scoped to the DB projection on purpose — see the tests at the bottom.
 */

import { afterEach, describe, expect, it } from "vitest"

import type { LiveMessage } from "@/contexts/acp-connections-context"
import type {
  ContentBlock,
  DbConversationDetail,
  MessageTurn,
} from "@/lib/types"
import {
  getTimelineTurns,
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"

const CID = 77

function userTurn(id: string): MessageTurn {
  return {
    id,
    role: "user",
    blocks: [{ type: "text", text: id }],
    timestamp: "2026-08-10T00:00:00.000Z",
  }
}

function assistantTurn(id: string, blocks: ContentBlock[]): MessageTurn {
  return {
    id,
    role: "assistant",
    blocks,
    timestamp: "2026-08-10T00:00:01.000Z",
  }
}

const poll = (id: string): ContentBlock => ({
  type: "tool_use",
  tool_use_id: id,
  tool_name: "mcp__codeg-mcp__get_delegation_status",
  input_preview: JSON.stringify({ task_ids: ["task-1"], wait_ms: 0 }),
})

const pollResult = (id: string): ContentBlock => ({
  type: "tool_result",
  tool_use_id: id,
  output_preview: '{"tasks":[{"task_id":"task-1","status":"completed"}]}',
  is_error: false,
})

function makeDetail(
  turns: MessageTurn[],
  inFlightUserTurnId: string | null
): DbConversationDetail {
  return {
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
      created_at: "2026-08-10T00:00:00.000Z",
      updated_at: "2026-08-10T00:00:00.000Z",
      pinned_at: null,
    },
    turns,
    in_flight_user_turn_id: inFlightUserTurnId,
  }
}

function seedSession(
  detail: DbConversationDetail,
  liveMessage?: LiveMessage,
  localTurns: MessageTurn[] = []
) {
  const session = {
    conversationId: CID,
    externalId: null,
    dbConversationId: null,
    detail,
    detailLoading: false,
    detailError: null,
    acpLoadError: null,
    localTurns,
    backgroundTurns: [],
    pendingBackgroundSettlements: [],
    optimisticTurns: [],
    liveMessage: liveMessage ?? null,
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
  }
  const next = new Map(useConversationRuntimeStore.getState().byConversationId)
  next.set(CID, session)
  useConversationRuntimeStore.setState({ byConversationId: next })
}

/** The in-flight-round flag the store attached to the turn with the given id. */
function inFlightRoundOf(turnId: string): boolean | undefined {
  return getTimelineTurns(CID).find((t) => t.turn.id === turnId)
    ?.isInFlightRound
}

/** The set the store attached to the persisted turn with the given id. */
function inProgressOf(turnId: string): Set<string> | undefined {
  return getTimelineTurns(CID).find((t) => t.turn.id === turnId)
    ?.inProgressToolCallIds
}

afterEach(() => {
  resetConversationRuntimeStore()
})

describe("in-flight tool calls inside a persisted transcript", () => {
  it("marks an unmatched call of the in-flight round", () => {
    seedSession(
      makeDetail(
        [userTurn("u1"), assistantTurn("a1", [poll("toolu_pending")])],
        "u1"
      )
    )
    expect(inProgressOf("a1")).toEqual(new Set(["toolu_pending"]))
  })

  it("leaves a call that already has its result alone", () => {
    seedSession(
      makeDetail(
        [
          userTurn("u1"),
          assistantTurn("a1", [
            poll("toolu_done"),
            pollResult("toolu_done"),
            poll("toolu_pending"),
          ]),
        ],
        "u1"
      )
    )
    expect(inProgressOf("a1")).toEqual(new Set(["toolu_pending"]))
  })

  it("does not mark anything when the backend reports no in-flight turn", () => {
    seedSession(
      makeDetail(
        [userTurn("u1"), assistantTurn("a1", [poll("toolu_orphan")])],
        null
      )
    )
    expect(inProgressOf("a1")).toBeUndefined()
  })

  it("never re-spins an orphan left by an EARLIER settled round", () => {
    // `a1` belongs to a round that ended without a result for its call (an
    // interrupted / orphaned poll). Only the round after the in-flight prompt
    // `u2` may be marked.
    seedSession(
      makeDetail(
        [
          userTurn("u1"),
          assistantTurn("a1", [poll("toolu_orphan")]),
          userTurn("u2"),
          assistantTurn("a2", [poll("toolu_live")]),
        ],
        "u2"
      )
    )
    expect(inProgressOf("a1")).toBeUndefined()
    expect(inProgressOf("a2")).toEqual(new Set(["toolu_live"]))
  })

  it("degrades to no marking when the named prompt is outside the window", () => {
    // Reverse-infinite-scroll page that doesn't contain the in-flight prompt.
    seedSession(
      makeDetail([assistantTurn("a1", [poll("toolu_x")])], "u-not-here")
    )
    expect(inProgressOf("a1")).toBeUndefined()
  })

  it("skips a block with no tool_use_id (the adapter can't key it either)", () => {
    seedSession(
      makeDetail(
        [
          userTurn("u1"),
          assistantTurn("a1", [
            {
              type: "tool_use",
              tool_use_id: null,
              tool_name: "Bash",
              input_preview: '{"command":"sleep 600"}',
            },
          ]),
        ],
        "u1"
      )
    )
    expect(inProgressOf("a1")).toBeUndefined()
  })
})

describe("isInFlightRound", () => {
  it("flags the persisted reply of the round the backend says is running", () => {
    seedSession(
      makeDetail([userTurn("u1"), assistantTurn("a1", [poll("t1")])], "u1")
    )
    expect(inFlightRoundOf("u1")).toBe(false)
    expect(inFlightRoundOf("a1")).toBe(true)
  })

  it("leaves an earlier settled round alone", () => {
    seedSession(
      makeDetail(
        [
          userTurn("u1"),
          assistantTurn("a1", [poll("t1"), pollResult("t1")]),
          userTurn("u2"),
          assistantTurn("a2", [poll("t2")]),
        ],
        "u2"
      )
    )
    expect(inFlightRoundOf("a1")).toBe(false)
    expect(inFlightRoundOf("a2")).toBe(true)
  })

  it("flags nothing when the named prompt is outside the loaded window", () => {
    seedSession(makeDetail([assistantTurn("a1", [poll("t1")])], "u-not-here"))
    expect(inFlightRoundOf("a1")).toBe(false)
  })

  it("never flags a locally promoted reply, however stale the marker", () => {
    // `completeTurn` promotes the finished reply into localTurns and
    // deliberately does NOT refetch, and the live-transcript viewer has no
    // settle-time refetch — so `detail` can keep naming `u1` as in flight for
    // the whole life of the view. Deriving the flag from the raw marker over
    // the assembled timeline (rather than over the DB projection) would leave
    // this finished reply "running" forever: never collapsing its progress and
    // permanently hiding its stats row and artifacts card.
    seedSession(makeDetail([userTurn("u1")], "u1"), undefined, [
      assistantTurn("local-a1", [poll("t1"), pollResult("t1")]),
    ])
    expect(inFlightRoundOf("u1")).toBe(false)
    expect(inFlightRoundOf("local-a1")).toBeUndefined()
  })
})
