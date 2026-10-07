/**
 * Two timeline rules hide a persisted assistant turn while a reply streams: the
 * `liveOwnsActiveTurn` tail strip (delegation-child dialog) and the
 * `in_flight_user_turn_id` partial suppression (cross-client viewer). Both are
 * only sound because the live stream is showing that same reply — so both have
 * to key off what the live message RENDERS, not off a live message existing.
 *
 * Those differ, and routinely. `status_changed → prompting` installs a fresh
 * `content: []` live message at the start of every turn and mirrors it into
 * this store (see "fires with isLive=true and a fresh non-null liveMessage when
 * a turn starts" in acp-connections-context.test.tsx); the mirror never writes a
 * null back over it, so the same object stays in hand for any part of a turn
 * that produces nothing this build renders. Keyed on the object, the persisted
 * reply was hidden with nothing put in its place: a blank agent turn.
 */

import { afterEach, describe, expect, it } from "vitest"

import type { LiveMessage } from "@/contexts/acp-connections-context"
import type { DbConversationDetail, MessageTurn, TurnRole } from "@/lib/types"
import {
  getTimelineTurns,
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"

const CID = 77
const TS = "2026-09-06T00:00:00.000Z"

function turn(id: string, role: TurnRole): MessageTurn {
  return { id, role, blocks: [{ type: "text", text: id }], timestamp: TS }
}

/** What the turn's own `prompting` transition installs, before any content. */
const promptingLiveMessage: LiveMessage = {
  id: "m1",
  role: "assistant",
  content: [],
  startedAt: Date.parse(TS),
}

/** A block Phase 2 drops, so this message renders exactly as much as `[]`. */
const emptyTextLiveMessage: LiveMessage = {
  ...promptingLiveMessage,
  content: [{ type: "text", text: "" }],
}

const replyLiveMessage: LiveMessage = {
  ...promptingLiveMessage,
  content: [{ type: "text", text: "streaming…" }],
}

/** A message the user sent mid-turn, with no reply to it yet. */
const steeringOnlyLiveMessage: LiveMessage = {
  ...promptingLiveMessage,
  content: [
    {
      type: "steering",
      id: "note-1",
      text: "also check the tests",
      createdAt: TS,
    },
  ],
}

function seed(
  turns: MessageTurn[],
  overrides: {
    liveMessage?: LiveMessage | null
    liveOwnsActiveTurn?: boolean
    localTurns?: MessageTurn[]
    inFlightUserTurnId?: string | null
  }
) {
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
      created_at: TS,
      updated_at: TS,
      pinned_at: null,
    },
    turns,
    in_flight_user_turn_id: overrides.inFlightUserTurnId ?? null,
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
    localTurns: overrides.localTurns ?? [],
    backgroundTurns: [],
    pendingBackgroundSettlements: [],
    optimisticTurns: [],
    liveMessage: overrides.liveMessage ?? null,
    syncState: "idle" as const,
    activeTurnToken: null,
    lastTurnOwned: false,
    liveOwnsActiveTurn: overrides.liveOwnsActiveTurn ?? false,
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

describe("persisted-tail strip vs. a live message that renders nothing", () => {
  it("keeps the child's reply while the new turn has produced nothing yet", () => {
    seed([turn("u1", "user"), turn("a1", "assistant")], {
      liveOwnsActiveTurn: true,
      liveMessage: promptingLiveMessage,
    })
    expect(timelineIds()).toEqual(["u1", "a1"])
  })

  it("keeps the child's reply when the live message holds only an empty block", () => {
    seed([turn("u1", "user"), turn("a1", "assistant")], {
      liveOwnsActiveTurn: true,
      liveMessage: emptyTextLiveMessage,
    })
    expect(timelineIds()).toEqual(["u1", "a1"])
  })

  it("still strips the persisted copy once the live message shows the reply", () => {
    seed([turn("u1", "user"), turn("a1", "assistant")], {
      liveOwnsActiveTurn: true,
      liveMessage: replyLiveMessage,
    })
    expect(timelineIds()).toEqual(["u1", `live-${CID}-m1`])
  })

  it("still strips for a promoted reply, which renders on its own", () => {
    seed([turn("u1", "user"), turn("a1", "assistant")], {
      liveOwnsActiveTurn: true,
      liveMessage: promptingLiveMessage,
      localTurns: [turn("promoted", "assistant")],
    })
    expect(timelineIds()).toEqual(["u1", "promoted"])
  })
})

describe("in-flight partial suppression vs. a live message that renders nothing", () => {
  it("keeps the persisted partial while the turn has produced nothing yet", () => {
    seed([turn("u1", "user"), turn("a1", "assistant")], {
      liveMessage: promptingLiveMessage,
      inFlightUserTurnId: "u1",
    })
    expect(timelineIds()).toEqual(["u1", "a1"])
  })

  it("keeps every persisted reply of the round, not just the newest", () => {
    seed(
      [
        turn("u1", "user"),
        turn("a1", "assistant"),
        turn("a2", "assistant"),
        turn("a3", "assistant"),
      ],
      { liveMessage: emptyTextLiveMessage, inFlightUserTurnId: "u1" }
    )
    expect(timelineIds()).toEqual(["u1", "a1", "a2", "a3"])
  })

  it("still hides the persisted partial once the live message shows the reply", () => {
    seed([turn("u1", "user"), turn("a1", "assistant")], {
      liveMessage: replyLiveMessage,
      inFlightUserTurnId: "u1",
    })
    expect(timelineIds()).toEqual(["u1", `live-${CID}-m1`])
  })

  it("keeps the persisted reply when the live message carries only a steer", () => {
    // A mid-turn message is the user's, not a rendering of the reply, so it
    // cannot stand in for the persisted copy it would otherwise hide.
    seed([turn("u1", "user"), turn("a1", "assistant")], {
      liveMessage: steeringOnlyLiveMessage,
      inFlightUserTurnId: "u1",
    })
    expect(timelineIds()).toEqual(["u1", "a1", `live-${CID}-m1`])
  })
})
