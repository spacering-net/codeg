/**
 * A message the user sends mid-turn is a USER turn the agent writes into the
 * MIDDLE of a round. Two timeline rules locate the running round by its newest
 * persisted user turn, and both read that message as the start of a new one:
 *
 *   - the viewer's persisted-tail strip anchors on the last persisted user turn
 *     (`liveOwnsActiveTurn`), so the anchor jumps forward past the reply's
 *     already-persisted first half and stops stripping it;
 *   - the in-flight partial suppression anchors on
 *     `detail.in_flight_user_turn_id`, which the backend stamps by matching the
 *     pending prompt against the transcript TAIL — and once the steered message
 *     IS the tail, the content no longer matches and nothing is stamped at all.
 *
 * Either way the persisted first half of the reply lands beside the live copy
 * of the same text, and `mergeConsecutiveAssistantTurns` glues them into one
 * bubble: the run-on paragraph the mid-turn split exists to prevent, back again
 * for every turn that is actually steered.
 *
 * Both anchors now step over the detail's own copies of this turn's mid-turn
 * messages — but only while the live message provably holds the round from
 * before the interruption, since stepping over one hides the persisted turns
 * behind it.
 */

import { afterEach, describe, expect, it } from "vitest"

import type {
  LiveContentBlock,
  LiveMessage,
} from "@/contexts/acp-connections-context"
import type { DbConversationDetail, MessageTurn, TurnRole } from "@/lib/types"
import {
  getTimelineTurns,
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"

const CID = 91
/** Older than every steer below, so history is provably a different message. */
const BEFORE = "2026-09-05T00:00:00.000Z"
/** When the backend injected the message, stamped where the agent runs. */
const STEER_AT = "2026-09-05T00:05:00.000Z"
/** A turn the agent wrote after that injection, i.e. its own copy of it. */
const AFTER_STEER = "2026-09-05T00:05:01.000Z"

const STEER_TEXT = "use the other API"

function turn(
  id: string,
  role: TurnRole,
  text: string,
  timestamp = BEFORE
): MessageTurn {
  return { id, role, blocks: [{ type: "text", text }], timestamp }
}

function steerBlock(text = STEER_TEXT, id = "n1"): LiveContentBlock {
  return { type: "steering", id, text, createdAt: STEER_AT, blocks: null }
}

function live(content: LiveContentBlock[]): LiveMessage {
  return {
    id: "lm",
    role: "assistant",
    content,
    startedAt: Date.parse(BEFORE),
  }
}

/** The whole round in hand: the reply opened, the user cut in, it went on. */
const splitReply = live([
  { type: "text", text: "half one" },
  steerBlock(),
  { type: "text", text: "half two" },
])

function seed(
  turns: MessageTurn[],
  o: {
    liveMessage?: LiveMessage | null
    liveOwnsActiveTurn?: boolean
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
      created_at: BEFORE,
      updated_at: BEFORE,
      pinned_at: null,
    },
    turns,
    in_flight_user_turn_id: o.inFlightUserTurnId ?? null,
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
    localTurns: [],
    backgroundTurns: [],
    pendingBackgroundSettlements: [],
    optimisticTurns: [],
    liveMessage: o.liveMessage ?? null,
    syncState: "idle" as const,
    activeTurnToken: null,
    lastTurnOwned: false,
    liveOwnsActiveTurn: o.liveOwnsActiveTurn ?? false,
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

/** What the thread actually reads, top to bottom. */
const timelineTexts = () =>
  getTimelineTurns(CID).map((t) =>
    t.turn.blocks[0]?.type === "text" ? t.turn.blocks[0].text : "?"
  )

/** The transcript mid-turn: the prompt, the reply so far, then the message the
 *  user cut in with — which the agent records as an ordinary user turn. */
const steeredTranscript = [
  turn("u1", "user", "the original prompt"),
  turn("a1", "assistant", "half one"),
  turn("u2", "user", STEER_TEXT, AFTER_STEER),
]

afterEach(() => {
  resetConversationRuntimeStore()
})

describe("persisted-tail strip vs. a message sent mid-turn", () => {
  it("strips the reply's first half, which the live stream is re-showing", () => {
    seed(steeredTranscript, {
      liveOwnsActiveTurn: true,
      liveMessage: splitReply,
    })
    expect(timelineTexts()).toEqual([
      "the original prompt",
      "half one",
      STEER_TEXT,
      "half two",
    ])
  })

  it("keeps the first half when the live message opens on the interruption", () => {
    // A session that adopted a snapshot mid-turn starts from the backend's live
    // message, which carries no steering block (the wire has no such kind), so a
    // steer arriving afterwards can be the first thing it holds of this turn.
    // The persisted first half is then rendered NOWHERE else — keep it, and let
    // the mid-turn message be the only thing the live copy stands in for.
    seed(steeredTranscript, {
      liveOwnsActiveTurn: true,
      liveMessage: live([steerBlock(), { type: "text", text: "half two" }]),
    })
    expect(timelineTexts()).toEqual([
      "the original prompt",
      "half one",
      STEER_TEXT,
      "half two",
    ])
  })

  it("leaves an earlier round's identical message in history", () => {
    // Steered text is short and repeatable. Reaching past the round's own
    // prompt would erase the same words the user sent three rounds ago for as
    // long as the turn runs.
    seed(
      [
        turn("u0", "user", STEER_TEXT),
        turn("a0", "assistant", "sure"),
        ...steeredTranscript,
      ],
      { liveOwnsActiveTurn: true, liveMessage: splitReply }
    )
    expect(timelineTexts()).toEqual([
      STEER_TEXT,
      "sure",
      "the original prompt",
      "half one",
      STEER_TEXT,
      "half two",
    ])
  })

  it("still anchors on the newest prompt when nothing was steered", () => {
    seed(
      [
        turn("u1", "user", "the original prompt"),
        turn("a1", "assistant", "half one"),
      ],
      {
        liveOwnsActiveTurn: true,
        liveMessage: live([{ type: "text", text: "half one" }]),
      }
    )
    expect(timelineTexts()).toEqual(["the original prompt", "half one"])
  })
})

describe("in-flight partial suppression vs. a message sent mid-turn", () => {
  it("hides the persisted partial once the steer has taken the backend's stamp away", () => {
    // `apply_in_flight_message_id` matches the pending prompt against the
    // transcript tail; the tail is now the steered message, whose content is
    // not the prompt's, so the detail comes back with no stamp at all.
    seed(steeredTranscript, {
      liveMessage: splitReply,
      inFlightUserTurnId: null,
    })
    expect(timelineTexts()).toEqual([
      "the original prompt",
      "half one",
      STEER_TEXT,
      "half two",
    ])
  })

  it("keeps the persisted partial when the live message opens on the interruption", () => {
    seed(steeredTranscript, {
      liveMessage: live([steerBlock(), { type: "text", text: "half two" }]),
      inFlightUserTurnId: null,
    })
    expect(timelineTexts()).toEqual([
      "the original prompt",
      "half one",
      STEER_TEXT,
      "half two",
    ])
  })

  it("keeps using the backend's stamp while it is there", () => {
    seed(steeredTranscript, {
      liveMessage: splitReply,
      inFlightUserTurnId: "u1",
    })
    expect(timelineTexts()).toEqual([
      "the original prompt",
      "half one",
      STEER_TEXT,
      "half two",
    ])
  })

  it("suppresses nothing when no steered copy has landed yet", () => {
    // The agent hasn't written its copy, so there is no evidence of which round
    // is running and no stamp to read: both persisted turns stand.
    seed(
      [
        turn("u1", "user", "the original prompt"),
        turn("a1", "assistant", "half one"),
      ],
      {
        liveMessage: splitReply,
        inFlightUserTurnId: null,
      }
    )
    expect(timelineTexts()).toEqual([
      "the original prompt",
      "half one",
      "half one",
      STEER_TEXT,
      "half two",
    ])
  })

  it("handles the same words sent twice in one turn", () => {
    // The shape content matching is worst at: two mid-turn messages the round
    // cannot tell apart by text. Each still has to render exactly once, in
    // place, with the reply between them.
    seed(
      [
        turn("u1", "user", "the original prompt"),
        turn("a1", "assistant", "half one"),
        turn("u2", "user", "continue", AFTER_STEER),
        turn("a2", "assistant", "half two"),
        turn("u3", "user", "continue", "2026-09-05T00:06:01.000Z"),
      ],
      {
        liveMessage: live([
          { type: "text", text: "half one" },
          steerBlock("continue"),
          { type: "text", text: "half two" },
          {
            type: "steering",
            id: "n2",
            text: "continue",
            createdAt: "2026-09-05T00:06:00.000Z",
            blocks: null,
          },
          { type: "text", text: "half three" },
        ]),
        inFlightUserTurnId: null,
      }
    )
    expect(timelineTexts()).toEqual([
      "the original prompt",
      "half one",
      "continue",
      "half two",
      "continue",
      "half three",
    ])
  })

  it("matches a message that carried an attachment", () => {
    // A steer with a draft attached is keyed on the blocks it actually sent,
    // which is what the agent writes to its transcript — the display text says
    // something else entirely.
    const image = {
      type: "image" as const,
      mime_type: "image/png",
      data: "AAAA",
      uri: "file:///shot.png",
    }
    seed(
      [
        turn("u1", "user", "the original prompt"),
        turn("a1", "assistant", "half one"),
        {
          id: "u2",
          role: "user",
          blocks: [image, { type: "text", text: "look at this" }],
          timestamp: AFTER_STEER,
        },
      ],
      {
        liveMessage: live([
          { type: "text", text: "half one" },
          {
            type: "steering",
            id: "n1",
            text: "look at this [image]",
            createdAt: STEER_AT,
            blocks: [
              { type: "image", mime_type: "image/png", data: "AAAA" },
              { type: "text", text: "look at this" },
            ],
          },
          { type: "text", text: "half two" },
        ]),
        inFlightUserTurnId: null,
      }
    )
    expect(getTimelineTurns(CID).map((t) => `${t.phase}:${t.turn.id}`)).toEqual(
      [
        "persisted:u1",
        `streaming:live-${CID}-lm`,
        `streaming:live-${CID}-lm-1`,
        `streaming:live-${CID}-lm-2`,
      ]
    )
  })

  it("handles two messages sent in the same turn", () => {
    seed(
      [
        turn("u1", "user", "the original prompt"),
        turn("a1", "assistant", "half one"),
        turn("u2", "user", STEER_TEXT, AFTER_STEER),
        turn("a2", "assistant", "half two"),
        turn("u3", "user", "and the other thing", AFTER_STEER),
      ],
      {
        liveMessage: live([
          { type: "text", text: "half one" },
          steerBlock(),
          { type: "text", text: "half two" },
          steerBlock("and the other thing", "n2"),
          { type: "text", text: "half three" },
        ]),
        inFlightUserTurnId: null,
      }
    )
    expect(timelineTexts()).toEqual([
      "the original prompt",
      "half one",
      STEER_TEXT,
      "half two",
      "and the other thing",
      "half three",
    ])
  })
})
