import { describe, expect, it } from "vitest"

import {
  advanceReplyFold,
  compactionOnlyPart,
  dedupeCompactionItems,
  extractDelegationSources,
  isForkPointUnnamed,
  markThreadTail,
  mergeConsecutiveAssistantTurns,
  singletonSourceTurns,
  type MergedAssistantRunCache,
  type ReplyFoldState,
  type ResolvedMessageGroup,
  type ThreadRenderItem,
} from "./message-list-view"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import type { MessageTurn } from "@/lib/types"

function turn(id: string): MessageTurn {
  return { id, role: "assistant", blocks: [], timestamp: "" }
}

type ThreadItem = Parameters<typeof mergeConsecutiveAssistantTurns>[0][number]
type TurnItem = Extract<ThreadItem, { kind: "turn" }>

function assistantItem(
  id: string,
  groupOverrides: Partial<TurnItem["group"]> = {}
): ThreadItem {
  return {
    key: `persisted-${id}`,
    kind: "turn",
    group: {
      id,
      role: "assistant",
      parts: [{ type: "text", text: `reply ${id}` }],
      resources: [],
      images: [],
      ...groupOverrides,
    },
    phase: "persisted",
    isResponseComplete: true,
    showStats: false,
    isRoleTransition: false,
    previousUserIndex: null,
    isLastAssistantRun: false,
    isThreadTail: false,
    sourceTurns: [],
  }
}

describe("advanceReplyFold", () => {
  const initial: ReplyFoldState = {
    signal: 0,
    epoch: 0,
    armed: false,
    running: false,
    runId: null,
    roundOpen: true,
  }
  // Live-message ids — the logical run, one per reply.
  const A = "lm-a"
  const B = "lm-b"
  const idle = (runId: string | null = null, sendSignal = 0) => ({
    sendSignal,
    running: false,
    runId,
  })
  const live = (runId: string, sendSignal = 0) => ({
    sendSignal,
    running: true,
    runId,
  })

  it("opens a conversation with every reply folded", () => {
    // Nothing is streaming on load, so no run is the current round and every
    // reply falls back to its own (empty) fold override.
    expect(advanceReplyFold(initial, idle(A))).toBe(initial)
  })

  it("arms once the agent starts replying and stays armed after it settles", () => {
    const armed = advanceReplyFold(initial, live(A))
    expect(armed.armed).toBe(true)
    // The reply settling must NOT disarm — that is the auto-fold-on-finish
    // this replaced. Only the running edge moves.
    const settled = advanceReplyFold(armed, idle(A))
    expect(settled.armed).toBe(true)
    expect(settled.roundOpen).toBe(true)
    expect(settled.running).toBe(false)
    // Steady state after that: nothing left to move.
    expect(advanceReplyFold(settled, idle(A))).toBe(settled)
  })

  it("keeps a hand-folded round folded while it settles", () => {
    const folded: ReplyFoldState = {
      signal: 0,
      epoch: 0,
      armed: true,
      running: true,
      runId: A,
      roundOpen: false,
    }
    expect(advanceReplyFold(folded, idle(A)).roundOpen).toBe(false)
  })

  it("folds the thread and disarms on send", () => {
    const settled = advanceReplyFold(
      advanceReplyFold(initial, live(A)),
      idle(A)
    )
    const sent = advanceReplyFold(settled, idle(A, 1))
    expect(sent).toMatchObject({
      signal: 1,
      armed: false,
      running: false,
      roundOpen: true,
    })
    // The epoch only ever has to MOVE — its absolute value is an invalidation
    // token, and a round starting bumps it too.
    expect(sent.epoch).toBeGreaterThan(settled.epoch)
  })

  it("re-arms immediately when a send lands mid-reply (steering)", () => {
    const armed = advanceReplyFold(initial, live(A))
    const steered = advanceReplyFold(armed, live(A, 1))
    // The reply being written is at once the new round: bumping the epoch folds
    // the history above it without folding the reply itself.
    expect(steered).toMatchObject({
      signal: 1,
      armed: true,
      running: true,
      roundOpen: true,
    })
    expect(steered.epoch).toBeGreaterThan(armed.epoch)
  })

  it("starts a fresh round on the running edge, with no send signal at all", () => {
    // `live-transcript-view` mounts MessageListView WITHOUT `sendSignal` for a
    // work-task transcript the engine drives through many rounds. Keying the
    // round off `sendSignal` alone left every finished round expanded there.
    let s = advanceReplyFold(initial, live(A)) // round 1 starts
    s = advanceReplyFold(s, idle(A)) // round 1 settles
    const roundOneEpoch = s.epoch

    const roundTwo = advanceReplyFold(s, live(B)) // round 2, same signal
    expect(roundTwo.armed).toBe(true)
    expect(roundTwo.roundOpen).toBe(true)
    expect(roundTwo.runId).toBe(B)
    // A fresh epoch is what folds round 1 shut behind round 2.
    expect(roundTwo.epoch).toBeGreaterThan(roundOneEpoch)
  })

  it("does not hand a hand-folded round's collapse to the next round", () => {
    // Same no-send host: folding round 1 by hand set `roundOpen: false`, and a
    // latched `armed` meant round 2 inherited it and arrived already collapsed.
    let s = advanceReplyFold(initial, live(A))
    s = { ...s, roundOpen: false } // reader folds the live round
    s = advanceReplyFold(s, idle(A)) // it settles, still folded
    expect(s.roundOpen).toBe(false)

    expect(advanceReplyFold(s, live(B)).roundOpen).toBe(true)
  })

  it("starts a fresh round for a streaming reply that merges behind a settled one", () => {
    // Background / loop turns arrive with no user turn between, so a settled
    // reply and a brand-new streaming one end up CONSECUTIVE and
    // `mergeConsecutiveAssistantTurns` folds them into one render item whose id
    // is pinned to the first member. Identifying the round by that id would
    // read the new reply as the old one resuming — it would arrive folded (if
    // the reader had folded the old one) with its live content hidden. The live
    // message is the run, so the merge cannot alias the two.
    let s = advanceReplyFold(initial, live(A))
    s = { ...s, roundOpen: false } // reader folds reply A
    s = advanceReplyFold(s, idle(null)) // A settles, live message cleared
    const settledEpoch = s.epoch

    const merged = advanceReplyFold(s, live(B))
    expect(merged.roundOpen).toBe(true)
    expect(merged.armed).toBe(true)
    expect(merged.epoch).toBeGreaterThan(settledEpoch)
  })

  it("latches a live identity that arrives after the round started", () => {
    // Mid-turn attach: a viewer joining a reply already in flight sees it
    // through the backend's in-flight marker first (running, but no live
    // message yet) and bridges the live stream a beat later. Leaving the round
    // anonymous gives a later re-bridge nothing to recognise the reply by.
    let s = advanceReplyFold(initial, {
      sendSignal: 0,
      running: true,
      runId: null,
    })
    s = advanceReplyFold(s, live(A)) // live stream attaches mid-round
    expect(s.runId).toBe(A)
    const latchedEpoch = s.epoch
    s = { ...s, roundOpen: false } // reader folds the reply

    s = advanceReplyFold(s, idle(null)) // premature COMPLETE_TURN
    const rebridged = advanceReplyFold(s, live(A))
    // Still the same reply: the latch is what keeps this from reading as new.
    expect(rebridged.epoch).toBe(latchedEpoch)
    expect(rebridged.roundOpen).toBe(false)
  })

  it("re-identifies, not re-rounds, when a running reply's id is rebased", () => {
    // `STATUS_CHANGED(prompting)` mints a client-side `randomUUID` live
    // message; a reconnect that hydrates from a snapshot swaps it wholesale for
    // the backend's, mid-reply. Reading that as a new round would re-open a
    // reply the reader had folded and fold the history they had opened — on
    // every reconnect.
    let s = advanceReplyFold(initial, live(A))
    s = { ...s, roundOpen: false } // reader folds the live reply
    const rebased = advanceReplyFold(s, live(B)) // snapshot hydration
    expect(rebased.runId).toBe(B)
    expect(rebased.epoch).toBe(s.epoch)
    expect(rebased.roundOpen).toBe(false)
    // And the new id is what a later re-bridge is recognised by.
    const settled = advanceReplyFold(rebased, idle(null))
    expect(advanceReplyFold(settled, live(B)).roundOpen).toBe(false)
  })

  it("treats a re-bridged live reply as the same round, not a new one", () => {
    // The runtime completes a live reply prematurely and then re-bridges the
    // SAME liveMessage while it is still streaming (see "drops the promoted
    // snapshot when the same liveMessage is still streaming" in
    // conversation-runtime-context.test.tsx). That reaches the fold state as
    // running true → false → true for ONE reply, carrying one unchanged id.
    let s = advanceReplyFold(initial, live(A))
    s = { ...s, roundOpen: false } // reader folds the live reply
    const armedEpoch = s.epoch

    s = advanceReplyFold(s, idle(A)) // premature COMPLETE_TURN
    const rebridged = advanceReplyFold(s, live(A)) // same liveMessage returns

    expect(rebridged.running).toBe(true)
    // Neither may move: a bump would fold history the reader had opened, and a
    // reset would re-open the reply they had just folded.
    expect(rebridged.epoch).toBe(armedEpoch)
    expect(rebridged.roundOpen).toBe(false)
  })
})

describe("singletonSourceTurns", () => {
  it("returns the same array reference for the same turn", () => {
    const t = turn("t1")
    const first = singletonSourceTurns(t)
    const second = singletonSourceTurns(t)
    // Reference stability is the whole point: it lets HistoricalMessageGroup's
    // memo bail out when an unchanged historical turn re-renders per token.
    expect(first).toBe(second)
    expect(first).toEqual([t])
  })

  it("returns distinct arrays for distinct turns", () => {
    const a = singletonSourceTurns(turn("a"))
    const b = singletonSourceTurns(turn("b"))
    expect(a).not.toBe(b)
  })
})

describe("mergeConsecutiveAssistantTurns", () => {
  it("surfaces completion time patched onto a non-last sub-turn", () => {
    // Real-device bug (Cursor session 118b6805): the post-turn metadata
    // patch head-aligns onto the FIRST local sub-turn when the parser emits
    // fewer turns than the live stream split into. The merged footer must
    // still show that completion time (and its duration), not the last
    // sub-turn's empty fields.
    const merged = mergeConsecutiveAssistantTurns([
      assistantItem("a", {
        duration_ms: 15_975,
        completed_at: "2026-07-19T05:25:22.851Z",
      }),
      assistantItem("b"),
    ])
    expect(merged).toHaveLength(1)
    const item = merged[0] as TurnItem
    expect(item.group.completed_at).toBe("2026-07-19T05:25:22.851Z")
    expect(item.group.duration_ms).toBe(15_975)
  })

  it("keeps the latest completion when several sub-turns carry one", () => {
    const merged = mergeConsecutiveAssistantTurns([
      assistantItem("a", { completed_at: "2026-07-19T05:25:10.000Z" }),
      assistantItem("b", { completed_at: "2026-07-19T05:25:22.851Z" }),
    ])
    expect(merged).toHaveLength(1)
    const item = merged[0] as TurnItem
    expect(item.group.completed_at).toBe("2026-07-19T05:25:22.851Z")
  })

  it("does not fold a compaction divider into the preceding assistant reply", () => {
    // The compaction event sits BETWEEN two assistant replies (the reply before
    // `/compact` and the next). Two bare assistant turns would merge into one;
    // the dedicated "compaction" item must break that run so the divider renders
    // standalone in the correct between-turns position (and the first reply keeps
    // its own footer).
    const compaction: ThreadItem = {
      key: "persisted-compact",
      kind: "compaction",
      meta: { contextCompaction: true, tokensBefore: 51777, tokensAfter: 4616 },
    }
    // Sanity: without the divider, the two assistant turns DO merge to one.
    expect(
      mergeConsecutiveAssistantTurns([assistantItem("a"), assistantItem("b")])
    ).toHaveLength(1)
    // With the divider between them, the run is broken → 3 standalone items.
    const merged = mergeConsecutiveAssistantTurns([
      assistantItem("a"),
      compaction,
      assistantItem("b"),
    ])
    expect(merged.map((it) => it.kind)).toEqual(["turn", "compaction", "turn"])
  })
})

function makeGroup(
  role: "user" | "assistant",
  id: string
): ResolvedMessageGroup {
  return { id, role, parts: [], resources: [], images: [] }
}

// Fresh render-item objects per call, like the rawItems map in threadItems —
// only `group`, `key`, and the sourceTurns wrapper carry identity.
function makeItem(
  group: ResolvedMessageGroup,
  index: number,
  phase: "persisted" | "optimistic" | "streaming" = "persisted"
): ThreadRenderItem {
  return {
    key: `${phase}-${group.id}-${index}`,
    kind: "turn",
    group,
    phase,
    isResponseComplete: phase === "persisted",
    showStats: false,
    isRoleTransition: false,
    previousUserIndex: null,
    isLastAssistantRun: false,
    isThreadTail: false,
    sourceTurns: singletonSourceTurns(turn(group.id)),
  }
}

function makeUserItem(id: string, index: number): ThreadRenderItem {
  const item = makeItem(makeGroup("user", id), index)
  if (item.kind === "turn") {
    item.group.parts = [{ type: "text", text: "hi" }]
  }
  return item
}

describe("mergeConsecutiveAssistantTurns merged-run cache", () => {
  it("reuses the merged item (group/parts/sourceTurns) when membership is unchanged", () => {
    const cache: MergedAssistantRunCache = new WeakMap()
    const g1 = makeGroup("assistant", "a1")
    const g2 = makeGroup("assistant", "a2")

    const out1 = mergeConsecutiveAssistantTurns(
      [makeItem(g1, 0), makeItem(g2, 1)],
      cache
    )
    const out2 = mergeConsecutiveAssistantTurns(
      [makeItem(g1, 0), makeItem(g2, 1)],
      cache
    )

    expect(out1).toHaveLength(1)
    const first = out1[0]
    const second = out2[0]
    if (first.kind !== "turn" || second.kind !== "turn") {
      throw new Error("expected turn items")
    }
    expect(second).toBe(first)
    expect(second.group).toBe(first.group)
    expect(second.group.parts).toBe(first.group.parts)
    expect(second.sourceTurns).toBe(first.sourceTurns)
    expect(first.key).toBe("merged-persisted-a1-0")
    expect(first.group.id).toBe("a1")
  })

  it("rebuilds a run whose member changed without touching a neighboring run", () => {
    const cache: MergedAssistantRunCache = new WeakMap()
    const g1 = makeGroup("assistant", "a1")
    const g2 = makeGroup("assistant", "a2")
    const g3 = makeGroup("assistant", "a3")
    const g4 = makeGroup("assistant", "a4")

    const out1 = mergeConsecutiveAssistantTurns(
      [
        makeItem(g1, 0),
        makeItem(g2, 1),
        makeUserItem("u1", 2),
        makeItem(g3, 3),
        makeItem(g4, 4),
      ],
      cache
    )
    // Second member of run A re-adapted (new group object, e.g. its turn was
    // reloaded); run B untouched.
    const g2b = makeGroup("assistant", "a2")
    const out2 = mergeConsecutiveAssistantTurns(
      [
        makeItem(g1, 0),
        makeItem(g2b, 1),
        makeUserItem("u1", 2),
        makeItem(g3, 3),
        makeItem(g4, 4),
      ],
      cache
    )

    expect(out2[0]).not.toBe(out1[0])
    expect(out2[2]).toBe(out1[2])
  })

  it("rebuilds when a persisted run changes from in-flight to completed", () => {
    const cache: MergedAssistantRunCache = new WeakMap()
    const g1 = makeGroup("assistant", "a1")
    const g2 = makeGroup("assistant", "a2")
    const firstItems = [makeItem(g1, 0), makeItem(g2, 1)]
    if (firstItems[1].kind !== "turn") throw new Error("expected turn")
    firstItems[1].isResponseComplete = false

    const out1 = mergeConsecutiveAssistantTurns(firstItems, cache)
    const out2 = mergeConsecutiveAssistantTurns(
      [makeItem(g1, 0), makeItem(g2, 1)],
      cache
    )

    expect(out2[0]).not.toBe(out1[0])
    if (out2[0].kind !== "turn") throw new Error("expected turn")
    expect(out2[0].isResponseComplete).toBe(true)
  })

  it("misses when the run gains a member, then caches the new membership", () => {
    const cache: MergedAssistantRunCache = new WeakMap()
    const g1 = makeGroup("assistant", "a1")
    const g2 = makeGroup("assistant", "a2")
    const g3 = makeGroup("assistant", "a3")

    const out1 = mergeConsecutiveAssistantTurns(
      [makeItem(g1, 0), makeItem(g2, 1)],
      cache
    )
    const out2 = mergeConsecutiveAssistantTurns(
      [makeItem(g1, 0), makeItem(g2, 1), makeItem(g3, 2)],
      cache
    )
    const out3 = mergeConsecutiveAssistantTurns(
      [makeItem(g1, 0), makeItem(g2, 1), makeItem(g3, 2)],
      cache
    )

    expect(out2[0]).not.toBe(out1[0])
    expect(out3[0]).toBe(out2[0])
  })

  it("keeps cache hits across interleaved empty (skipped) turn items", () => {
    const cache: MergedAssistantRunCache = new WeakMap()
    const g1 = makeGroup("assistant", "a1")
    const g2 = makeGroup("assistant", "a2")
    const emptyUser = () => makeItem(makeGroup("user", "empty"), 1)

    const out1 = mergeConsecutiveAssistantTurns(
      [makeItem(g1, 0), emptyUser(), makeItem(g2, 2)],
      cache
    )
    const out2 = mergeConsecutiveAssistantTurns(
      [makeItem(g1, 0), emptyUser(), makeItem(g2, 2)],
      cache
    )

    // The empty user turn is transparent: one merged item, no user item.
    expect(out1).toHaveLength(1)
    expect(out2[0]).toBe(out1[0])
  })

  it("passes single-turn runs through untouched without caching", () => {
    const cache: MergedAssistantRunCache = new WeakMap()
    const item = makeItem(makeGroup("assistant", "solo"), 0)

    const out = mergeConsecutiveAssistantTurns([item], cache)

    expect(out).toHaveLength(1)
    expect(out[0]).toBe(item)
  })

  it("still merges correctly without a cache", () => {
    const g1 = makeGroup("assistant", "a1")
    const g2 = makeGroup("assistant", "a2")

    const out1 = mergeConsecutiveAssistantTurns([
      makeItem(g1, 0),
      makeItem(g2, 1),
    ])
    const out2 = mergeConsecutiveAssistantTurns([
      makeItem(g1, 0),
      makeItem(g2, 1),
    ])

    expect(out1).toHaveLength(1)
    expect(out2[0]).not.toBe(out1[0])
    expect(out2[0]).toEqual(out1[0])
  })
})

describe("extractDelegationSources", () => {
  function toolCall(
    toolCallId: string,
    toolName: string,
    input?: string | null
  ): AdaptedContentPart {
    return {
      type: "tool-call",
      toolCallId,
      toolName,
      input: input ?? null,
      state: "output-available",
      output: null,
    }
  }

  it("collects a delegate_to_agent call keyed by its own tool_use_id", () => {
    const sources = extractDelegationSources([
      toolCall(
        "tu-1",
        "mcp__codeg-mcp__delegate_to_agent",
        '{"agent_type":"codex"}'
      ),
    ])
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({
      parentToolUseId: "tu-1",
      input: '{"agent_type":"codex"}',
    })
    expect(sources[0].taskIdHint).toBeUndefined()
  })

  // The overlay lists the sub-agents of the LAST reply. A reply that RESUMED
  // one contains no `delegate_to_agent` call at all (the original is in an
  // earlier turn), so without this arm a resumed sub-agent would be missing
  // from the overlay for its whole second run.
  it("collects a resume_delegation call keyed by the task id in its arguments", () => {
    const sources = extractDelegationSources([
      toolCall("tu-resume", "resume_delegation", '{"task_id":"task-abc"}'),
    ])
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({
      parentToolUseId: "tu-resume",
      taskIdHint: "task-abc",
      // Not the `{task_id, reason}` arguments — `parseInput` would only warn.
      input: null,
    })
  })

  it("skips a resume whose task id is unreadable, and de-dupes repeats", () => {
    const sources = extractDelegationSources([
      toolCall("tu-a", "resume_delegation", "{}"),
      toolCall(
        "tu-b",
        "mcp__codeg-mcp__resume_delegation",
        '{"task_id":"t-1"}'
      ),
      toolCall("tu-c", "resume_delegation", '{"task_id":"t-1"}'),
    ])
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({ parentToolUseId: "tu-b" })
  })

  it("finds delegations nested inside tool-groups and goal-runs", () => {
    const sources = extractDelegationSources([
      {
        type: "tool-group",
        items: [
          toolCall("tu-resume", "resume_delegation", '{"task_id":"t-1"}'),
        ],
      } as AdaptedContentPart,
    ])
    expect(sources).toHaveLength(1)
    expect(sources[0].taskIdHint).toBe("t-1")
  })

  it("ignores unrelated tool calls", () => {
    expect(
      extractDelegationSources([
        toolCall("tu-1", "bash", '{"command":"ls"}'),
        toolCall("tu-2", "get_delegation_status", '{"task_ids":["t-1"]}'),
      ])
    ).toEqual([])
  })

  // A refusal reports the task's REAL status plus its agent and child, so it
  // reads like a successful resume to everything but `error_code`. Listing it
  // would put a sub-agent in the overlay that this reply never revived.
  it("skips a refused resume", () => {
    const refused: AdaptedContentPart = {
      type: "tool-call",
      toolCallId: "tu-resume",
      toolName: "resume_delegation",
      input: '{"task_id":"t-1"}',
      state: "output-available",
      output: JSON.stringify({
        task_id: "t-1",
        status: "completed",
        error_code: "not_resumable",
        agent_type: "codex",
        child_conversation_id: 9,
        message: "Not resumed: the task already completed.",
      }),
    }
    expect(extractDelegationSources([refused])).toEqual([])
  })
})

/**
 * The fork affordance sends a turn id to the backend, and the backend cannot
 * resolve an id this client minted for its own live stream — it tail-forks
 * instead of refusing. That is the right answer for the newest reply and a
 * silent wrong one for any earlier reply, which a steered turn creates: it
 * promotes as assistant / user message / assistant, so its first half sits
 * settled and non-tail with a fork button while the parser's name is still a
 * reparse away.
 */
describe("isForkPointUnnamed", () => {
  function forkTurn(id: string, sourceTurnId?: string | null): MessageTurn {
    return {
      id,
      role: "assistant",
      blocks: [],
      timestamp: "",
      ...(sourceTurnId !== undefined ? { source_turn_id: sourceTurnId } : {}),
    }
  }

  it("withholds a live-named reply that is not the thread's last item", () => {
    expect(isForkPointUnnamed(forkTurn("live-7-lm-1"), false)).toBe(true)
  })

  it("allows one at the end of the thread — there the tail IS the fork point", () => {
    expect(isForkPointUnnamed(forkTurn("live-7-lm-1"), true)).toBe(false)
  })

  it("withholds the newest REPLY when a message follows it", () => {
    // Steering at the very end of a turn promotes as assistant + user message
    // with nothing after it: the reply is the newest one, and still not the
    // tail. The backend's tail fork would land after the steered message, and
    // a parse ending on a user turn never backfills a name to correct it — so
    // "newest assistant run" is the wrong exception and `isThreadTail` is the
    // right one.
    expect(isForkPointUnnamed(forkTurn("live-7-lm"), false)).toBe(true)
  })

  it("allows it again once the reparse names it", () => {
    expect(isForkPointUnnamed(forkTurn("live-7-lm-1", "turn-4"), false)).toBe(
      false
    )
  })

  it("leaves parser-named history alone", () => {
    // Every historical turn arrives under a parser id and no `source_turn_id`;
    // treating that as unnamed would grey out the whole thread.
    expect(isForkPointUnnamed(forkTurn("turn-4"), false)).toBe(false)
  })

  it("says nothing about a group with no turns", () => {
    expect(isForkPointUnnamed(null, false)).toBe(false)
  })
})

describe("markThreadTail", () => {
  const compaction: ThreadItem = {
    key: "persisted-compact",
    kind: "compaction",
    meta: { contextCompaction: true },
  }
  const tailFlags = (items: ThreadItem[]) =>
    items.map((it) => (it.kind === "turn" ? it.isThreadTail : null))

  it("marks the last rendered turn", () => {
    const items = [assistantItem("a"), assistantItem("b")]
    markThreadTail(items)
    expect(tailFlags(items)).toEqual([false, true])
  })

  it("leaves a reply unmarked when a message follows it", () => {
    // The shape a steer at the very end of a turn promotes to: the reply is
    // still the newest one, and the tail is the message after it.
    const items = [assistantItem("a"), makeUserItem("u", 1)]
    markThreadTail(items)
    expect(tailFlags(items)).toEqual([false, true])
  })

  it("marks nothing when a compaction divider is last", () => {
    const items = [assistantItem("a"), compaction]
    markThreadTail(items)
    expect(tailFlags(items)).toEqual([false, null])
  })

  it("steps over a trailing turn that renders nothing", () => {
    const items = [assistantItem("a"), assistantItem("empty", { parts: [] })]
    markThreadTail(items)
    expect(tailFlags(items)).toEqual([true, false])
  })

  it("marks nothing in an empty thread", () => {
    const items: ThreadItem[] = []
    markThreadTail(items)
    expect(items).toEqual([])
  })
})

describe("dedupeCompactionItems", () => {
  const divider = (
    key: string,
    payload: Record<string, unknown>
  ): ThreadItem => ({
    key,
    kind: "compaction",
    meta: { contextCompaction: { version: 1, ...payload } },
  })
  const full = { preTokens: 108716, postTokens: 4462, durationMs: 92728 }
  const keys = (items: ThreadItem[]) => items.map((i) => i.key)

  // The live ACP tool_call and the transcript-derived divider are the same
  // compaction under two ids, and mid-turn both are in the timeline at once.
  it("keeps the first of two renderings of one compaction", () => {
    const items = [
      assistantItem("a"),
      divider("persisted-c", full),
      assistantItem("b"),
      divider("live-c", full),
    ]
    expect(keys(dedupeCompactionItems(items))).toEqual([
      "persisted-a",
      "persisted-c",
      "persisted-b",
    ])
  })

  it("keeps two genuinely different compactions", () => {
    const items = [
      divider("c1", full),
      divider("c2", {
        preTokens: 475949,
        postTokens: 12634,
        durationMs: 134503,
      }),
    ]
    expect(dedupeCompactionItems(items)).toHaveLength(2)
  })

  // codex-acp sends a bare `{version: 1}` for every compaction it runs, so a
  // key that tolerated missing counters would fold a whole session's
  // compactions into one.
  it("never folds payloads that cannot identify an event", () => {
    const bare = [divider("c1", {}), divider("c2", {})]
    expect(dedupeCompactionItems(bare)).toHaveLength(2)
    const partial = [
      divider("c1", { preTokens: 100, postTokens: 10 }),
      divider("c2", { preTokens: 100, postTokens: 10 }),
    ]
    expect(dedupeCompactionItems(partial)).toHaveLength(2)
    // grok's boolean-marker shape carries no versioned payload at all.
    const grok: ThreadItem[] = [
      { key: "g1", kind: "compaction", meta: { contextCompaction: true } },
      { key: "g2", kind: "compaction", meta: { contextCompaction: true } },
    ]
    expect(dedupeCompactionItems(grok)).toHaveLength(2)
  })

  // Identity-stable so the memo around it does not invalidate every batch.
  it("returns the input array when nothing is dropped", () => {
    const items = [assistantItem("a"), divider("c1", full)]
    expect(dedupeCompactionItems(items)).toBe(items)
  })
})

describe("compactionOnlyPart", () => {
  function compactionGroup(
    state: "input-available" | "output-available"
  ): ResolvedMessageGroup {
    return {
      id: "live-1",
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          toolCallId: "cmp_1",
          toolName: "Context compaction",
          input: null,
          state,
          output: "We kept the parser notes.",
          meta: {
            contextCompaction: { version: 1 },
            "codeg.compactionSummary": true,
          },
        },
      ],
      resources: [],
      images: [],
    }
  }

  // A `/compact` still running is a compaction-only live turn, hoisted like a
  // finished one — so the hoisted item has to keep the lifecycle, or it reads
  // "compacted" (and its summary renders settled) while it is still going.
  it("carries the call's state and claimed summary onto the hoisted item", () => {
    expect(compactionOnlyPart(compactionGroup("input-available"))).toEqual({
      meta: {
        contextCompaction: { version: 1 },
        "codeg.compactionSummary": true,
      },
      summary: "We kept the parser notes.",
      state: "input-available",
    })
    expect(compactionOnlyPart(compactionGroup("output-available"))?.state).toBe(
      "output-available"
    )
  })
})
