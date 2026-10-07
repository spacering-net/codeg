import { afterEach, describe, expect, it } from "vitest"
import {
  computeTurnMetadataPatches,
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"
import type { DbConversationDetail, MessageTurn, TurnUsage } from "@/lib/types"

// The post-turn reparse (`syncTurnMetadata`) backfills usage/duration/model
// onto this session's completed local turns by aligning them to a fresh parse.
// The parse contains persisted history + this session's turns; only the tail
// past `persistedAssistantCount` may align to `localTurns`. These tests pin the
// history anchor — without it, resuming a conversation folded every prior
// turn's stats into the first new reply (first reply after resume showed the
// SUM of all durations; second reply onward was correct; a full reload fixed
// every reply because it renders parsed turns directly).

function usage(input: number, output = 0): TurnUsage {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }
}

function asst(over: Partial<MessageTurn>): MessageTurn {
  return {
    id: "a",
    role: "assistant",
    blocks: [],
    timestamp: "2026-01-01T00:00:00Z",
    ...over,
  }
}

function user(id: string): MessageTurn {
  return { id, role: "user", blocks: [], timestamp: "2026-01-01T00:00:00Z" }
}

describe("computeTurnMetadataPatches", () => {
  it("does not fold historical turns' stats into the first reply after resume", () => {
    // Resume a conversation with 3 historical assistant turns (in `detail`),
    // then send one prompt. localTurns = [user, assistant] → assistant at 1.
    const parsedAssistantTurns = [
      asst({ id: "h0", duration_ms: 5000, usage: usage(100) }),
      asst({ id: "h1", duration_ms: 7000, usage: usage(200) }),
      asst({ id: "h2", duration_ms: 9000, usage: usage(300) }),
      asst({ id: "new", duration_ms: 1234, usage: usage(50) }),
    ]

    const patches = computeTurnMetadataPatches({
      localAssistantIndices: [1],
      parsedAssistantTurns,
      persistedAssistantCount: 3,
      parseEndsWithAssistant: true,
    })

    // The new reply gets ITS OWN duration/usage — not 1234 + 5000+7000+9000.
    expect(patches).toEqual([
      {
        index: 1,
        duration_ms: 1234,
        usage: usage(50),
        model: undefined,
        completed_at: undefined,
        source_turn_id: "new",
      },
    ])
  })

  it("folds extra parser sub-turns into local[0] when there is no history", () => {
    // Fresh conversation: the parser split one live reply into 3 sub-turns,
    // but the live stream produced a single assistant turn (index 0). Their
    // stats must sum so the post-stream total matches a fresh reload.
    const parsedAssistantTurns = [
      asst({ id: "s0", duration_ms: 1000, usage: usage(10, 1) }),
      asst({ id: "s1", duration_ms: 2000, usage: usage(20, 2) }),
      asst({
        id: "s2",
        duration_ms: 3000,
        usage: usage(30, 3),
        model: "gpt-x",
        completed_at: "2026-01-01T00:05:00Z",
      }),
    ]

    const patches = computeTurnMetadataPatches({
      localAssistantIndices: [0],
      parsedAssistantTurns,
      persistedAssistantCount: 0,
      parseEndsWithAssistant: true,
    })

    expect(patches).toEqual([
      {
        index: 0,
        duration_ms: 6000,
        usage: usage(60, 6),
        model: "gpt-x",
        // Completion time is the matched (last) sub-turn's, not aggregated.
        completed_at: "2026-01-01T00:05:00Z",
        // No fork anchor: a surplus of parsed turns is not provably a split
        // of THIS reply (it is equally an out-of-turn record), so the id is
        // withheld and "fork from here" falls back to a tail fork.
        source_turn_id: undefined,
      },
    ])
  })

  it("folds only this session's sub-turns after resume, never history", () => {
    // Resume (3 historical), then a reply the parser split into 2 sub-turns
    // while the live stream produced a single assistant turn (index 1).
    const parsedAssistantTurns = [
      asst({ id: "h0", duration_ms: 5000, usage: usage(100) }),
      asst({ id: "h1", duration_ms: 7000, usage: usage(200) }),
      asst({ id: "h2", duration_ms: 9000, usage: usage(300) }),
      asst({ id: "n0", duration_ms: 400, usage: usage(4) }),
      asst({ id: "n1", duration_ms: 600, usage: usage(6), model: "m" }),
    ]

    const patches = computeTurnMetadataPatches({
      localAssistantIndices: [1],
      parsedAssistantTurns,
      persistedAssistantCount: 3,
      parseEndsWithAssistant: true,
    })

    // 400 + 600 = 1000 (only n0 + n1), usage 4 + 6 = 10 — history excluded.
    expect(patches).toEqual([
      {
        index: 1,
        duration_ms: 1000,
        usage: usage(10),
        model: "m",
        completed_at: undefined,
        source_turn_id: undefined,
      },
    ])
  })

  it("names nothing when the parse holds more turns than this session streamed", () => {
    // A surplus has two indistinguishable causes and neither is placeable.
    // Sub-turn split: locals [A, B] against parsed [A, B1, B2] where B is the
    // one that split — tail alignment maps A onto B1, so naming A would fork
    // past A's own reply AND the user prompt after it. Out-of-turn record: the
    // extra is a turn this client never streamed (an async sub-agent reply, a
    // co-controlling client) and even the tail is then someone else's. Both
    // are frozen by first-write-wins, so neither turn is named. Stats keep the
    // old whole-batch alignment: only the id is withheld.
    const parsedAssistantTurns = [
      asst({ id: "A", duration_ms: 100, usage: usage(1) }),
      asst({ id: "B1", duration_ms: 200, usage: usage(2) }),
      asst({ id: "B2", duration_ms: 300, usage: usage(3) }),
    ]

    const patches = computeTurnMetadataPatches({
      localAssistantIndices: [1, 3],
      parsedAssistantTurns,
      persistedAssistantCount: 0,
      parseEndsWithAssistant: true,
    })

    expect(patches.map((patch) => patch.source_turn_id)).toEqual([
      undefined,
      undefined,
    ])
  })

  it("names nothing when an out-of-turn reply lands after the streamed one", () => {
    // Locals [B]; a Claude async sub-agent appended its own assistant reply C
    // after B, so the parse is [B, C] and ends on an assistant turn. Treating
    // the parse tail as "the reply that just completed" would name B with C's
    // id and fork from B at C.
    const parsedAssistantTurns = [
      asst({ id: "B", duration_ms: 100, usage: usage(1) }),
      asst({ id: "C", duration_ms: 200, usage: usage(2) }),
    ]

    const patches = computeTurnMetadataPatches({
      localAssistantIndices: [1],
      parsedAssistantTurns,
      persistedAssistantCount: 0,
      parseEndsWithAssistant: true,
    })

    expect(patches.map((patch) => patch.source_turn_id)).toEqual([undefined])
  })

  it("emits no patch when the parse has not caught up to the new reply", () => {
    // The turn completed but the transcript hasn't flushed the new reply yet:
    // the parse only has the 3 historical turns. Rather than mapping the new
    // local turn onto the last historical parsed turn (the original bug — a
    // non-null usage there also suppressed the retry, locking a wrong value),
    // emit nothing so the caller's retry picks up the complete parse.
    const parsedAssistantTurns = [
      asst({ id: "h0", duration_ms: 5000, usage: usage(100) }),
      asst({ id: "h1", duration_ms: 7000, usage: usage(200) }),
      asst({ id: "h2", duration_ms: 9000, usage: usage(300) }),
    ]

    const patches = computeTurnMetadataPatches({
      localAssistantIndices: [1],
      parsedAssistantTurns,
      persistedAssistantCount: 3,
      parseEndsWithAssistant: true,
    })

    expect(patches).toEqual([])
  })

  it("maps each resumed reply to its own parsed turn (second reply onward)", () => {
    // Two prompts after resume: localTurns = [u1, a1, u2, a2].
    const parsedAssistantTurns = [
      asst({ id: "h0", duration_ms: 5000 }),
      asst({ id: "h1", duration_ms: 7000 }),
      asst({ id: "a1", duration_ms: 111, usage: usage(11) }),
      asst({ id: "a2", duration_ms: 222, usage: usage(22) }),
    ]

    const patches = computeTurnMetadataPatches({
      localAssistantIndices: [1, 3],
      parsedAssistantTurns,
      persistedAssistantCount: 2,
      parseEndsWithAssistant: true,
    })

    expect(patches).toEqual([
      {
        index: 1,
        duration_ms: 111,
        usage: usage(11),
        model: undefined,
        completed_at: undefined,
        source_turn_id: "a1",
      },
      {
        index: 3,
        duration_ms: 222,
        usage: usage(22),
        model: undefined,
        completed_at: undefined,
        source_turn_id: "a2",
      },
    ])
  })

  it("head-aligns a lagging parse so a later reply never inherits earlier stats", () => {
    // Two prompts after resume (localTurns = [u1, a1, u2, a2]) but the reparse
    // only has a1 yet (a2 not flushed). Tail-aligning a negative offset would
    // map a1's parse onto a2 and — with first-write-wins metadata — lock a1's
    // duration/tokens onto the second reply. a1 gets its own stats; a2 none.
    // The transcript ends on u2 (agents write the prompt before the reply), so
    // no turn is NAMED here either — see the lagging-split case below.
    const parsedAssistantTurns = [
      asst({ id: "h0", duration_ms: 5000 }),
      asst({ id: "h1", duration_ms: 7000 }),
      asst({ id: "a1", duration_ms: 111, usage: usage(11) }),
    ]

    const patches = computeTurnMetadataPatches({
      localAssistantIndices: [1, 3],
      parsedAssistantTurns,
      persistedAssistantCount: 2,
      parseEndsWithAssistant: false,
    })

    expect(patches).toEqual([
      {
        index: 1,
        duration_ms: 111,
        usage: usage(11),
        model: undefined,
        completed_at: undefined,
        source_turn_id: undefined,
      },
    ])
  })

  it("names nothing while the transcript still ends on a user turn", () => {
    // The case counts cannot catch: reply A split three ways AND reply B has
    // not flushed, so locals [A,B] meet parsed [A1,A2,A3] at offset 1. B looks
    // like the tail and would be named "A3" — forking from B would fork at A,
    // frozen there by first-write-wins. The transcript ending on B's user
    // prompt is what gives it away, and the sync retries, so refusing to name
    // costs a round rather than the feature.
    const parsedAssistantTurns = [
      asst({ id: "A1", duration_ms: 100, usage: usage(1) }),
      asst({ id: "A2", duration_ms: 200, usage: usage(2) }),
      asst({ id: "A3", duration_ms: 300, usage: usage(3) }),
    ]

    const patches = computeTurnMetadataPatches({
      localAssistantIndices: [1, 3],
      parsedAssistantTurns,
      persistedAssistantCount: 0,
      parseEndsWithAssistant: false,
    })

    expect(patches.map((patch) => patch.source_turn_id)).toEqual([
      undefined,
      undefined,
    ])
  })

  it("names a turn the parser recorded with no stats of its own", () => {
    // The reported "fork from here" bug. A turn produced in this session is
    // named `live-<conv>-<msg>`, which the backend cannot resolve against its
    // own parse — so forking from it silently forked at the TAIL and the new
    // session came out identical to its parent. The parser's name has to reach
    // the local turn, and it has to reach it even when the parsed turn carries
    // no usage/duration at all (a plain codex reply does not), or the guard
    // that skips empty patches would drop the one field that matters.
    const patches = computeTurnMetadataPatches({
      localAssistantIndices: [1],
      parsedAssistantTurns: [asst({ id: "turn-3" })],
      persistedAssistantCount: 0,
      parseEndsWithAssistant: true,
    })

    expect(patches).toEqual([
      {
        index: 1,
        duration_ms: undefined,
        usage: undefined,
        model: undefined,
        completed_at: undefined,
        source_turn_id: "turn-3",
      },
    ])
  })

  it("clamps an over-count boundary instead of slicing past the parse", () => {
    // Defensive: if `detail` momentarily reports more assistant turns than the
    // fresh parse (e.g. a transient in-flight partial), the clamp keeps the
    // slice empty rather than going negative — no patch, safe retry.
    const parsedAssistantTurns = [asst({ id: "n0", duration_ms: 400 })]

    const patches = computeTurnMetadataPatches({
      localAssistantIndices: [1],
      parsedAssistantTurns,
      persistedAssistantCount: 5,
      parseEndsWithAssistant: true,
    })

    expect(patches).toEqual([])
  })
})

// The boundary `syncTurnMetadata` feeds into the helper above is the session's
// `historyAssistantBaseline`, snapshotted from settled `detail` when a batch
// begins — NOT read from `detail` at backfill time (which can be a mid-stream
// snapshot carrying this reply's own partial, or one that has already folded an
// earlier current-session reply into history). These tests pin that capture.

const CID = 4242

function detailWith(
  turns: MessageTurn[],
  inFlightUserTurnId?: string
): DbConversationDetail {
  return {
    summary: {
      id: CID,
      title: null,
      agent_type: "codex",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
    turns,
    in_flight_user_turn_id: inFlightUserTurnId ?? null,
  } as unknown as DbConversationDetail
}

function seedDetail(turns: MessageTurn[], inFlightUserTurnId?: string) {
  // Seed `detail` the way a settled/mid-stream load leaves it, then read back
  // the captured baseline.
  useConversationRuntimeStore.setState((s) => {
    const byId = new Map(s.byConversationId)
    const cur = byId.get(CID)
    const base = cur ?? {
      conversationId: CID,
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
    }
    byId.set(CID, {
      ...base,
      detail: detailWith(turns, inFlightUserTurnId),
    })
    return { byConversationId: byId }
  })
}

function baseline(): number | null {
  return (
    useConversationRuntimeStore.getState().byConversationId.get(CID)
      ?.historyAssistantBaseline ?? null
  )
}

describe("historyAssistantBaseline capture", () => {
  afterEach(() => resetConversationRuntimeStore())

  it("snapshots the settled-history assistant count on the first prompt of a batch", () => {
    seedDetail([user("u0"), asst({ id: "a0" }), user("u1"), asst({ id: "a1" })])
    useConversationRuntimeStore
      .getState()
      .actions.appendOptimisticTurn(CID, user("new"), "tok-1")
    expect(baseline()).toBe(2)
  })

  it("does not move the baseline on a follow-up prompt in the same batch", () => {
    seedDetail([asst({ id: "a0" })])
    const { actions } = useConversationRuntimeStore.getState()
    actions.appendOptimisticTurn(CID, user("u1"), "tok-1")
    expect(baseline()).toBe(1)
    // completeTurn promotes the prompt into localTurns, so the batch is now
    // "in flight" with a non-empty buffer.
    actions.completeTurn(CID, {
      id: "live-1",
      role: "assistant",
      content: [],
      startedAt: 0,
    })
    // The next prompt is a follow-up in the same batch (localTurns non-empty),
    // so the batch-start baseline (1) must NOT be recomputed.
    useConversationRuntimeStore
      .getState()
      .actions.appendOptimisticTurn(CID, user("u2"), "tok-2")
    expect(baseline()).toBe(1)
  })

  it("captures 0 for a fresh conversation with no history", () => {
    // No detail at all → boundary 0 → the reparse treats the whole parse as
    // this session's, correct when there is no history.
    useConversationRuntimeStore
      .getState()
      .actions.appendOptimisticTurn(CID, user("first"), "tok-1")
    expect(baseline()).toBe(0)
  })

  it("captures the baseline on a co-controller's echoed prompt, not just the owner send", () => {
    // A viewer/co-controller receives another client's prompt via
    // APPEND_VIEWER_USER_TURN (no optimistic send of its own). Its reply is
    // still a disjoint batch reaching syncTurnMetadata, so the boundary must be
    // captured here too — otherwise `?? 0` folds history into the reply.
    seedDetail([user("u0"), asst({ id: "a0" })])
    useConversationRuntimeStore
      .getState()
      .actions.appendViewerUserTurn(CID, user("from-other-client"))
    expect(baseline()).toBe(1)
  })

  it("captures on a viewer prompt DEDUPED by the backend stamp, excluding the partial", () => {
    // Viewer attaches mid-stream: `detail` already holds the in-flight prompt
    // (backend-stamped) plus a persisted PARTIAL reply (OpenCode/Gemini shape).
    // The exact-id dedup fires, but the boundary must still be captured — and
    // count only the assistants BEFORE the in-flight prompt (1 history reply),
    // excluding the partial that follows it.
    seedDetail(
      [user("u0"), asst({ id: "a0" }), user("p1"), asst({ id: "partial" })],
      "p1"
    )
    useConversationRuntimeStore.getState().actions.appendViewerUserTurn(
      CID,
      // Same id as the stamped in-flight prompt → exact-id dedup path.
      user("p1")
    )
    expect(baseline()).toBe(1)
  })

  it("captures on a viewer prompt DEDUPED by trailing-user content match", () => {
    // Claude/Codex mid-stream shape: `detail` ends at the in-flight prompt (no
    // partial). The content-dedup guard fires (trailing user turn matches), but
    // the boundary must still be captured — all history assistants precede it.
    seedDetail([user("u0"), asst({ id: "a0" }), user("p1")])
    useConversationRuntimeStore
      .getState()
      // A different id but empty-blocks content matches the trailing user turn.
      .actions.appendViewerUserTurn(CID, user("echo-of-p1"))
    expect(baseline()).toBe(1)
  })

  it("ignores a STALE in-flight marker on an owner send (counts the prior reply as history)", () => {
    // `detail` carries a stale `in_flight_user_turn_id = p1` left over from a
    // COMPLETED prior turn [.. p1, a1]. A brand-new owner send must NOT trust
    // it: a1 is history, so the boundary is 2 (a0 + a1), not 1. Trusting the
    // marker would drop a1 and fold its usage/duration into the new reply.
    seedDetail(
      [user("u0"), asst({ id: "a0" }), user("p1"), asst({ id: "a1" })],
      "p1"
    )
    useConversationRuntimeStore
      .getState()
      .actions.appendOptimisticTurn(CID, user("brand-new"), "tok-1")
    expect(baseline()).toBe(2)
  })

  it("ignores a stale marker for a DISTINCT viewer prompt too", () => {
    // Same stale-marker detail, but a distinct viewer prompt (not the marker's
    // id, content doesn't match the trailing assistant) → appends → all history.
    seedDetail(
      [user("u0"), asst({ id: "a0" }), user("p1"), asst({ id: "a1" })],
      "p1"
    )
    useConversationRuntimeStore
      .getState()
      .actions.appendViewerUserTurn(CID, user("different-prompt"))
    expect(baseline()).toBe(2)
  })
})
