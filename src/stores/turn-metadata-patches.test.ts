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
// every reply because it renders parsed turns directly) — and the per-round
// alignment: both sides split one reply into several sub-turns, by different
// rules, so only the user turns between replies can say which parsed sub-turns
// belong to which local reply.

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

function system(id: string): MessageTurn {
  return {
    id,
    role: "system",
    blocks: [{ type: "turn_error", message: "boom" }],
    timestamp: "2026-01-01T00:00:00Z",
  }
}

/** A local (live-stream) assistant turn: it carries no stats of its own. */
function live(id: string): MessageTurn {
  return asst({ id })
}

/** Three settled rounds of history, one assistant turn each. */
const HISTORY: MessageTurn[] = [
  user("u0"),
  asst({ id: "h0", duration_ms: 5000, usage: usage(100) }),
  user("u1"),
  asst({ id: "h1", duration_ms: 7000, usage: usage(200) }),
  user("u2"),
  asst({ id: "h2", duration_ms: 9000, usage: usage(300) }),
]

function durations(patches: { index: number; duration_ms?: number | null }[]) {
  return Object.fromEntries(patches.map((p) => [p.index, p.duration_ms]))
}

describe("computeTurnMetadataPatches", () => {
  it("does not fold historical turns' stats into the first reply after resume", () => {
    // Resume a conversation with 3 historical assistant turns (in `detail`),
    // then send one prompt. localTurns = [user, assistant] → assistant at 1.
    const patches = computeTurnMetadataPatches({
      localTurns: [user("p"), live("live")],
      parsedTurns: [
        ...HISTORY,
        user("p"),
        asst({ id: "new", duration_ms: 1234, usage: usage(50) }),
      ],
      persistedAssistantCount: 3,
      parseOpensAtBatch: false,
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

  it("folds extra parser sub-turns into the reply's first local turn", () => {
    // Fresh conversation: the parser split one live reply into 3 sub-turns,
    // but the live stream produced a single assistant turn (index 1). Their
    // stats must sum so the post-stream total matches a fresh reload.
    const patches = computeTurnMetadataPatches({
      localTurns: [user("p"), live("live")],
      parsedTurns: [
        user("p"),
        asst({ id: "s0", duration_ms: 1000, usage: usage(10, 1) }),
        asst({ id: "s1", duration_ms: 2000, usage: usage(20, 2) }),
        asst({
          id: "s2",
          duration_ms: 3000,
          usage: usage(30, 3),
          model: "gpt-x",
          completed_at: "2026-01-01T00:05:00Z",
        }),
      ],
      persistedAssistantCount: 0,
      parseOpensAtBatch: true,
      parseEndsWithAssistant: true,
    })

    expect(patches).toEqual([
      {
        index: 1,
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
    const patches = computeTurnMetadataPatches({
      localTurns: [user("p"), live("live")],
      parsedTurns: [
        ...HISTORY,
        user("p"),
        asst({ id: "n0", duration_ms: 400, usage: usage(4) }),
        asst({ id: "n1", duration_ms: 600, usage: usage(6), model: "m" }),
      ],
      persistedAssistantCount: 3,
      parseOpensAtBatch: false,
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

  it("gives every reply of a tab left open its own sub-turns, not just the first", () => {
    // The reported bug: a tab keeps its `localTurns` across every prompt sent
    // in it, and each reply is several sub-turns on BOTH sides, split by
    // different rules — here the live stream split each reply in two while
    // the parser split them in four and five. Aligned as one flat list, the
    // whole surplus rolled into the session's first reply and the second got
    // only its last two parsed sub-turns: 30 seconds of a reply that ran for
    // 14.5 minutes.
    const min = 60_000
    const patches = computeTurnMetadataPatches({
      localTurns: [
        user("p1"),
        live("r1-a"),
        live("r1-b"),
        user("p2"),
        live("r2-a"),
        live("r2-b"),
      ],
      parsedTurns: [
        user("p1"),
        asst({ id: "a1", duration_ms: 1 * min, usage: usage(1) }),
        asst({ id: "a2", duration_ms: 2 * min, usage: usage(2) }),
        asst({ id: "a3", duration_ms: 3 * min, usage: usage(3) }),
        asst({ id: "a4", duration_ms: 4 * min, usage: usage(4) }),
        user("p2"),
        asst({ id: "b1", duration_ms: 5 * min, usage: usage(10) }),
        asst({ id: "b2", duration_ms: 4 * min, usage: usage(20) }),
        asst({ id: "b3", duration_ms: 5 * min, usage: usage(30) }),
        asst({ id: "b4", duration_ms: 20_000, usage: usage(40) }),
        asst({ id: "b5", duration_ms: 10_000, usage: usage(50) }),
      ],
      persistedAssistantCount: 0,
      parseOpensAtBatch: true,
      parseEndsWithAssistant: true,
    })

    expect(durations(patches)).toEqual({
      1: 1 * min + 2 * min + 3 * min,
      2: 4 * min,
      4: 5 * min + 4 * min + 5 * min + 20_000,
      5: 10_000,
    })
    // Tokens ride the same alignment: the second reply's two local turns add
    // up to all five of its parsed sub-turns, and nothing of the first.
    expect(patches[2].usage).toEqual(usage(10 + 20 + 30 + 40))
    expect(patches[3].usage).toEqual(usage(50))
  })

  it("pairs replies across a steer and a failed round's closing line", () => {
    // A message sent mid-reply is a user turn on both sides — the live
    // stream's steering group and the parser's folded `queued_command` — so it
    // splits that reply into two rounds. A failed round's `system` line opens
    // none: the next prompt does.
    const patches = computeTurnMetadataPatches({
      localTurns: [
        user("p1"),
        live("r1"),
        user("steer"),
        live("r1-after"),
        system("err"),
        user("p2"),
        live("r2"),
      ],
      parsedTurns: [
        user("p1"),
        asst({ id: "a1", duration_ms: 100 }),
        asst({ id: "a2", duration_ms: 200 }),
        user("steer"),
        asst({ id: "b1", duration_ms: 300 }),
        system("err"),
        user("p2"),
        asst({ id: "c1", duration_ms: 400 }),
        asst({ id: "c2", duration_ms: 500 }),
      ],
      persistedAssistantCount: 0,
      parseOpensAtBatch: true,
      parseEndsWithAssistant: true,
    })

    expect(durations(patches)).toEqual({ 1: 300, 3: 300, 6: 900 })
  })

  it("leaves the newest reply unpatched while the parse lags a whole round", () => {
    // Two prompts in the tab, but the transcript has not reached the second
    // one yet. Its round must not borrow the first reply's sub-turns — first-
    // write-wins would lock them in — so it stays unpatched for the retry.
    const localTurns = [user("p1"), live("r1"), user("p2"), live("r2")]
    const firstRound = [
      user("p1"),
      asst({ id: "a1", duration_ms: 100, usage: usage(1) }),
      asst({ id: "a2", duration_ms: 200, usage: usage(2) }),
    ]
    for (const parsedTurns of [firstRound, [...firstRound, user("p2")]]) {
      for (const parseOpensAtBatch of [true, false]) {
        const patches = computeTurnMetadataPatches({
          localTurns,
          parsedTurns,
          persistedAssistantCount: 0,
          parseOpensAtBatch,
          parseEndsWithAssistant: false,
        })
        expect(durations(patches)).toEqual({ 1: 300 })
      }
    }
  })

  it("pairs a parse cut at a deduped viewer prompt from its start, even a round behind", () => {
    // A viewer batch whose first prompt deduped against `detail` opens on the
    // reply, and the parse is cut right after that prompt. With the second
    // prompt not on disk yet, the parse holds ONE round to the tab's two:
    // the first reply's 10 minutes belong to the first reply, and the newest
    // stays unpatched — never the other way round, which first-write-wins
    // would lock in.
    const patches = computeTurnMetadataPatches({
      localTurns: [live("l1"), user("p2"), live("l2")],
      parsedTurns: [asst({ id: "a1", duration_ms: 600_000, usage: usage(10) })],
      persistedAssistantCount: 0,
      parseOpensAtBatch: true,
      parseEndsWithAssistant: true,
    })

    expect(durations(patches)).toEqual({ 0: 600_000 })
  })

  it("ignores rounds the parse holds beyond the tab's", () => {
    // Another client's prompt (and the start of its reply) can reach the
    // transcript before this tab takes it in. Paired from the end, every
    // reply would have shifted one round on; paired from the batch's start,
    // the extra round is simply not this batch's yet.
    const patches = computeTurnMetadataPatches({
      localTurns: [user("p1"), live("r1"), user("p2"), live("r2")],
      parsedTurns: [
        user("p1"),
        asst({ id: "a1", duration_ms: 100 }),
        user("p2"),
        asst({ id: "b1", duration_ms: 200 }),
        user("p3"),
        asst({ id: "c1", duration_ms: 400 }),
      ],
      persistedAssistantCount: 0,
      parseOpensAtBatch: true,
      parseEndsWithAssistant: true,
    })

    expect(durations(patches)).toEqual({ 1: 100, 3: 200 })
    // Its reply also leaves the totals apart, so nothing is named.
    expect(patches.map((patch) => patch.source_turn_id)).toEqual([
      undefined,
      undefined,
    ])
  })

  it("folds the parse's leading rounds into a reply with no prompt on this side", () => {
    // The sub-agent adopt path: the local reply has no user turn before it,
    // and the (unwindowed) parse is the child's whole transcript. The flat
    // alignment summed all of it into that reply; so does this.
    const patches = computeTurnMetadataPatches({
      localTurns: [live("adopted")],
      parsedTurns: [
        user("kickoff"),
        asst({ id: "s0", duration_ms: 1000 }),
        asst({
          id: "s1",
          duration_ms: 2000,
          completed_at: "2026-01-01T00:01:00Z",
        }),
      ],
      persistedAssistantCount: 0,
      parseOpensAtBatch: false,
      parseEndsWithAssistant: true,
    })

    expect(patches).toEqual([
      {
        index: 0,
        duration_ms: 3000,
        usage: undefined,
        model: undefined,
        completed_at: "2026-01-01T00:01:00Z",
        source_turn_id: undefined,
      },
    ])
  })

  it("aligns a viewer batch whose first prompt deduped against the detail", () => {
    // The echo of the prompt the viewer attached during deduped against the
    // persisted copy, so `localTurns` opens on the reply — and the window
    // opens right after that prompt too.
    const patches = computeTurnMetadataPatches({
      localTurns: [live("r1"), user("p2"), live("r2")],
      parsedTurns: [
        asst({ id: "a1", duration_ms: 100 }),
        asst({ id: "a2", duration_ms: 200 }),
        user("p2"),
        asst({ id: "b1", duration_ms: 300 }),
        asst({ id: "b2", duration_ms: 400 }),
      ],
      persistedAssistantCount: 0,
      parseOpensAtBatch: true,
      parseEndsWithAssistant: true,
    })

    expect(durations(patches)).toEqual({ 0: 300, 2: 700 })
  })

  it("pairs from the end when the parse may still hold history at its front", () => {
    // A batch captured with no detail loaded (a tab kept hidden since the
    // workspace restored) has no boundary, so the sync reads the whole
    // transcript. None of that history belongs to the batch's reply — the
    // flat alignment summed all of it in.
    const patches = computeTurnMetadataPatches({
      localTurns: [user("p"), live("r")],
      parsedTurns: [
        asst({ id: "out-of-turn", duration_ms: 60_000 }),
        ...HISTORY,
        user("p"),
        asst({ id: "n0", duration_ms: 400 }),
        asst({ id: "n1", duration_ms: 600 }),
      ],
      persistedAssistantCount: 0,
      parseOpensAtBatch: false,
      parseEndsWithAssistant: true,
    })

    expect(durations(patches)).toEqual({ 1: 1000 })
  })

  it("drops an out-of-turn reply the window holds ahead of the batch's prompt", () => {
    // A reply Claude Code started on its own between the detail load and the
    // send lands past the boundary, in front of the prompt. It is nobody's
    // reply in this tab: round 0 is empty on the local side.
    const patches = computeTurnMetadataPatches({
      localTurns: [user("p"), live("r")],
      parsedTurns: [
        asst({ id: "out-of-turn", duration_ms: 60_000 }),
        user("p"),
        asst({ id: "n0", duration_ms: 400 }),
        asst({ id: "n1", duration_ms: 600 }),
      ],
      persistedAssistantCount: 0,
      parseOpensAtBatch: true,
      parseEndsWithAssistant: true,
    })

    expect(durations(patches)).toEqual({ 1: 1000 })
  })

  it("names nothing when the parse holds more turns than this session streamed", () => {
    // A surplus has two indistinguishable causes and neither is placeable.
    // Sub-turn split: locals [A, B] against parsed [A, B1, B2] where B is the
    // one that split — the flat mapping puts A onto B1, so naming A would fork
    // past A's own reply AND the user prompt after it. Out-of-turn record: the
    // extra is a turn this client never streamed (an async sub-agent reply, a
    // co-controlling client) and even the tail is then someone else's. Both
    // are frozen by first-write-wins, so neither turn is named. The stats
    // still land round by round: only the id is withheld.
    const patches = computeTurnMetadataPatches({
      localTurns: [user("pa"), live("A"), user("pb"), live("B")],
      parsedTurns: [
        user("pa"),
        asst({ id: "A", duration_ms: 100, usage: usage(1) }),
        user("pb"),
        asst({ id: "B1", duration_ms: 200, usage: usage(2) }),
        asst({ id: "B2", duration_ms: 300, usage: usage(3) }),
      ],
      persistedAssistantCount: 0,
      parseOpensAtBatch: true,
      parseEndsWithAssistant: true,
    })

    expect(patches.map((patch) => patch.source_turn_id)).toEqual([
      undefined,
      undefined,
    ])
    expect(durations(patches)).toEqual({ 1: 100, 3: 500 })
  })

  it("names nothing when an out-of-turn reply lands after the streamed one", () => {
    // Locals [B]; a Claude async sub-agent appended its own assistant reply C
    // after B, so the parse is [B, C] and ends on an assistant turn. Treating
    // the parse tail as "the reply that just completed" would name B with C's
    // id and fork from B at C.
    const patches = computeTurnMetadataPatches({
      localTurns: [user("p"), live("B")],
      parsedTurns: [
        user("p"),
        asst({ id: "B", duration_ms: 100, usage: usage(1) }),
        asst({ id: "C", duration_ms: 200, usage: usage(2) }),
      ],
      persistedAssistantCount: 0,
      parseOpensAtBatch: true,
      parseEndsWithAssistant: true,
    })

    expect(patches.map((patch) => patch.source_turn_id)).toEqual([undefined])
  })

  it("emits no patch when the parse has not caught up to the new reply", () => {
    // The turn completed but the transcript hasn't flushed the new reply yet:
    // the parse only has the 3 historical turns (and at most the new prompt).
    // Rather than mapping the new local turn onto the last historical parsed
    // turn (the original bug — a non-null usage there also suppressed the
    // retry, locking a wrong value), emit nothing so the caller's retry picks
    // up the complete parse.
    for (const parsedTurns of [HISTORY, [...HISTORY, user("p")]]) {
      const patches = computeTurnMetadataPatches({
        localTurns: [user("p"), live("live")],
        parsedTurns,
        persistedAssistantCount: 3,
        parseOpensAtBatch: false,
        parseEndsWithAssistant: false,
      })
      expect(patches).toEqual([])
    }
  })

  it("maps each resumed reply to its own parsed turn (second reply onward)", () => {
    // Two prompts after resume: localTurns = [u1, a1, u2, a2].
    const patches = computeTurnMetadataPatches({
      localTurns: [user("p1"), live("l1"), user("p2"), live("l2")],
      parsedTurns: [
        user("u0"),
        asst({ id: "h0", duration_ms: 5000 }),
        user("u1"),
        asst({ id: "h1", duration_ms: 7000 }),
        user("p1"),
        asst({ id: "a1", duration_ms: 111, usage: usage(11) }),
        user("p2"),
        asst({ id: "a2", duration_ms: 222, usage: usage(22) }),
      ],
      persistedAssistantCount: 2,
      parseOpensAtBatch: false,
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
    // only has a1 yet (a2 not flushed). Tail-aligning would map a1's parse
    // onto a2 and — with first-write-wins metadata — lock a1's duration/tokens
    // onto the second reply. a1 gets its own stats; a2 none. The transcript
    // ends on u2 (agents write the prompt before the reply), so no turn is
    // NAMED here either — see the lagging-split case below.
    const patches = computeTurnMetadataPatches({
      localTurns: [user("p1"), live("l1"), user("p2"), live("l2")],
      parsedTurns: [
        user("u0"),
        asst({ id: "h0", duration_ms: 5000 }),
        user("u1"),
        asst({ id: "h1", duration_ms: 7000 }),
        user("p1"),
        asst({ id: "a1", duration_ms: 111, usage: usage(11) }),
        user("p2"),
      ],
      persistedAssistantCount: 2,
      parseOpensAtBatch: false,
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
    // not flushed, so locals [A,B] meet parsed [A1,A2,A3] at a flat offset of
    // 1. B looks like the tail and would be named "A3" — forking from B would
    // fork at A, frozen there by first-write-wins. The transcript ending on
    // B's user prompt is what gives it away, and the sync retries, so refusing
    // to name costs a round rather than the feature. B's round is not on disk
    // yet, so it gets no stats either.
    const patches = computeTurnMetadataPatches({
      localTurns: [user("pa"), live("A"), user("pb"), live("B")],
      parsedTurns: [
        user("pa"),
        asst({ id: "A1", duration_ms: 100, usage: usage(1) }),
        asst({ id: "A2", duration_ms: 200, usage: usage(2) }),
        asst({ id: "A3", duration_ms: 300, usage: usage(3) }),
        user("pb"),
      ],
      persistedAssistantCount: 0,
      parseOpensAtBatch: true,
      parseEndsWithAssistant: false,
    })

    expect(patches.map((patch) => patch.source_turn_id)).toEqual([undefined])
    expect(durations(patches)).toEqual({ 1: 600 })
  })

  it("names nothing while the parse ends on a prompt, even with every round lined up", () => {
    // Rounds and totals agree here, so only `parseEndsWithAssistant` stands
    // between these turns and a name: the transcript ending on a user turn is
    // the sign it is not settled.
    const call = (parseEndsWithAssistant: boolean) =>
      computeTurnMetadataPatches({
        localTurns: [user("pa"), live("A"), user("pb"), live("B")],
        parsedTurns: [
          user("pa"),
          asst({ id: "A1", duration_ms: 100 }),
          user("pb"),
          asst({ id: "B1", duration_ms: 200 }),
          user("pc"),
        ],
        persistedAssistantCount: 0,
        parseOpensAtBatch: true,
        parseEndsWithAssistant,
      }).map((patch) => patch.source_turn_id)

    expect(call(false)).toEqual([undefined, undefined])
    expect(call(true)).toEqual(["A1", "B1"])
  })

  it("names nothing when the rounds disagree even though the totals match", () => {
    // The live stream split the first reply in two and the parser split the
    // second in two: three turns a side. Mapped straight across, the first
    // reply's last turn would be named after the second reply's first
    // sub-turn, and "fork from here" on it would keep half of the second
    // reply. The stats still land in their own rounds.
    const patches = computeTurnMetadataPatches({
      localTurns: [
        user("p1"),
        live("r1-a"),
        live("r1-b"),
        user("p2"),
        live("r2"),
      ],
      parsedTurns: [
        user("p1"),
        asst({ id: "a1", duration_ms: 100 }),
        user("p2"),
        asst({ id: "b1", duration_ms: 200 }),
        asst({ id: "b2", duration_ms: 300 }),
      ],
      persistedAssistantCount: 0,
      parseOpensAtBatch: true,
      parseEndsWithAssistant: true,
    })

    expect(patches.map((patch) => patch.source_turn_id)).toEqual([
      undefined,
      undefined,
    ])
    expect(durations(patches)).toEqual({ 1: 100, 4: 500 })
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
      localTurns: [user("p"), live("live")],
      parsedTurns: [user("p"), asst({ id: "turn-3" })],
      persistedAssistantCount: 0,
      parseOpensAtBatch: true,
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
    const patches = computeTurnMetadataPatches({
      localTurns: [user("p"), live("live")],
      parsedTurns: [user("p"), asst({ id: "n0", duration_ms: 400 })],
      persistedAssistantCount: 5,
      parseOpensAtBatch: false,
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
      pendingCancelledTurnReports: null,
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
    // A fresh chat streams under a virtual (negative) runtime id until its
    // first send creates the row, and has no detail: boundary 0 → the reparse
    // treats the whole parse as this session's, correct when there is no
    // history.
    const DRAFT = -CID
    useConversationRuntimeStore
      .getState()
      .actions.appendOptimisticTurn(DRAFT, user("first"), "tok-1")
    const session = useConversationRuntimeStore
      .getState()
      .byConversationId.get(DRAFT)
    expect(session?.historyAssistantBaseline).toBe(0)
    expect(session?.batchBoundaryIndex).toBe(0)
  })

  it("claims no boundary for a persisted conversation whose detail never loaded", () => {
    // A tab kept hidden since the workspace restored loads its detail only
    // when first shown, so a prompt reaching it (the owner's queue, or another
    // client's echo) finds history it has not read. Claiming index 0 would
    // put that whole history at the front of the batch.
    const { actions } = useConversationRuntimeStore.getState()
    actions.appendOptimisticTurn(CID, user("first"), "tok-1")
    expect(baseline()).toBeNull()
    expect(
      useConversationRuntimeStore.getState().byConversationId.get(CID)
        ?.batchBoundaryIndex
    ).toBeNull()

    resetConversationRuntimeStore()
    useConversationRuntimeStore
      .getState()
      .actions.appendViewerUserTurn(CID, user("from-other-client"))
    expect(
      useConversationRuntimeStore.getState().byConversationId.get(CID)
        ?.batchBoundaryIndex
    ).toBeNull()
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
