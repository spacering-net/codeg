/**
 * The "Load background activity" pill (out-of-turn wire content) refetches
 * with `preserveLive: true`. The promoted round it keeps in `localTurns` can
 * be one the refreshed detail now covers — an OpenCode background sub-agent
 * round is the canonical case (see FETCH_DETAIL_SUCCESS in
 * conversation-runtime-store): the foreground round completed and promoted
 * long before the background round ran, so its persisted twin is in the new
 * parse under a parser id (`msg_…`) `dedupeTimeline` can never match against
 * the promoted `live-<cid>-…` id. Keeping it renders the whole old round a
 * second time BELOW the newer persisted tail, which reads as "the newest
 * messages jumped to the top".
 *
 * Retirement must rest on the batch-boundary alignment proof
 * (`retireBatchCoveredLocalTurns`), never on timestamp ordering: promoted
 * turns carry the client-clock round START, so the round's own persisted
 * prompt reads "newer" than its reply, and a timestamp rule retires the only
 * copy of a reply whose record has not flushed yet (the review repro on
 * PR #1187 — the keep-cases below pin that loss).
 *
 * Turn ids mirror the real failure (opencode session
 * ses_e117f284affeNxE0ryo9ujXPRm, 2026-11-18): parser turns carry `msg_…`
 * ids, promoted live turns carry `live-<cid>-…` ids.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  getTimelineTurns,
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"
import { extendPrefixFingerprint, FNV_SEED_HEX } from "@/lib/turn-window"
import type { DbConversationDetail, MessageTurn } from "@/lib/types"

vi.mock("@/lib/api", () => ({
  getFolderConversation: vi.fn(),
}))

const { getFolderConversation } = await import("@/lib/api")
const mockGetFolderConversation = vi.mocked(getFolderConversation)

const CID = 7

/**
 * A windowed response over `full`, starting at global `offset` — mirrors the
 * backend's `apply_turn_window` (prefix_hash = fingerprint of full[0..offset)).
 */
function windowed(
  full: MessageTurn[],
  offset: number,
  overrides: Partial<DbConversationDetail> = {}
): DbConversationDetail {
  const prefixHash = extendPrefixFingerprint(
    FNV_SEED_HEX,
    full.slice(0, offset)
  )
  if (prefixHash === null) throw new Error("fingerprint failed")
  return {
    summary: {
      id: CID,
      folder_id: 1,
      agent_type: "open_code",
      title: "t",
      title_locked: false,
      status: "in_progress",
      kind: "regular",
      model: null,
      git_branch: null,
      external_id: "ses_x",
      message_count: full.length,
      child_count: 0,
      created_at: full[0]?.timestamp ?? "2026-11-18T00:00:00.000Z",
      updated_at:
        full[full.length - 1]?.timestamp ?? "2026-11-18T00:00:00.000Z",
      pinned_at: null,
    },
    turns: full.slice(offset),
    in_flight_user_turn_id: null,
    turns_offset: offset,
    turns_total: full.length,
    prefix_hash: prefixHash,
    uncovered_prefix_max_ts: offset > 0 ? full[offset - 1]!.timestamp : null,
    ...overrides,
  }
}

/** The batch-boundary capture `batchStartCapture` writes at send time. */
function boundary(
  full: MessageTurn[],
  index: number
): { batchBoundaryIndex: number; batchBoundaryPrefixHash: string } {
  const hash = extendPrefixFingerprint(FNV_SEED_HEX, full.slice(0, index))
  if (hash === null) throw new Error("fingerprint failed")
  return { batchBoundaryIndex: index, batchBoundaryPrefixHash: hash }
}

function turn(id: string, role: "user" | "assistant", ts: string): MessageTurn {
  return { id, role, blocks: [{ type: "text", text: id }], timestamp: ts }
}

// ── The real failure's shape ─────────────────────────────────────────────
// 11:55 user asks; 11:55:18 the subagent-launch round ends and promotes;
// 12:02:50 the background round lands out-of-turn (wire-dropped, pill armed).
const T0 = "2026-11-18T03:55:01.000Z"
const T1 = "2026-11-18T03:55:11.000Z"
const T2 = "2026-11-18T03:55:18.000Z"
const T3 = "2026-11-18T04:02:50.000Z"

// Persisted (parser) copies: ids are the opencode message ids.
const userP = turn("msg_user", "user", T0)
const a1P = turn("msg_a1", "assistant", T1)
const a2P = turn("msg_a2", "assistant", T2)
const bgP = turn("msg_a3", "assistant", T3) // the newest, background round

// Promoted live copies of the SAME round 1 (ids as COMPLETE_TURN builds them).
const userL = turn(`live-${CID}-m0`, "user", T0)
const a1L = turn(`live-${CID}-m1`, "assistant", T1)
const a2L = turn(`live-${CID}-m2`, "assistant", T2)
const promotedRound = [userL, a1L, a2L]
const promotedIds = promotedRound.map((t) => t.id)

// Earlier, fully-persisted history for the long-conversation cases.
const hist = [
  turn("msg_u0", "user", "2026-11-18T03:00:00.000Z"),
  turn("msg_a0", "assistant", "2026-11-18T03:00:05.000Z"),
]

function seed(
  currentDetail: DbConversationDetail,
  overrides: {
    localTurns?: MessageTurn[]
    batchBoundaryIndex?: number | null
    batchBoundaryPrefixHash?: string | null
    liveOwnsActiveTurn?: boolean
    liveMessage?: unknown
  } = {}
) {
  const next = new Map(useConversationRuntimeStore.getState().byConversationId)
  next.set(CID, {
    conversationId: CID,
    externalId: "ses_x",
    dbConversationId: null,
    detail: currentDetail,
    detailLoading: false,
    detailError: null,
    acpLoadError: null,
    localTurns: overrides.localTurns ?? [],
    backgroundTurns: [],
    pendingBackgroundSettlements: [],
    optimisticTurns: [],
    liveMessage: (overrides.liveMessage as null) ?? null,
    syncState: "idle" as const,
    activeTurnToken: null,
    lastTurnOwned: true,
    liveOwnsActiveTurn: overrides.liveOwnsActiveTurn ?? false,
    delegationKickoffText: null,
    sessionStats: null,
    historyAssistantBaseline: null,
    batchBoundaryIndex: overrides.batchBoundaryIndex ?? null,
    batchBoundaryPrefixHash: overrides.batchBoundaryPrefixHash ?? null,
    loadingOlderTurns: false,
    olderTurnsPrependEpoch: 0,
    pendingOutOfTurnContent: true,
    pendingCleanup: false,
  })
  useConversationRuntimeStore.setState({ byConversationId: next })
}

function actions() {
  return useConversationRuntimeStore.getState().actions
}

function sessionLocalTurnIds(): string[] {
  return (
    useConversationRuntimeStore.getState().byConversationId.get(CID)
      ?.localTurns ?? []
  ).map((t) => t.id)
}

/** refetchDetail's dispatch chain needs several microtask hops to land. */
async function flushMicrotasks() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
  }
}

beforeEach(() => {
  resetConversationRuntimeStore()
  mockGetFolderConversation.mockReset()
})

afterEach(() => {
  resetConversationRuntimeStore()
})

describe("load-background-activity pill refetch (preserveLive)", () => {
  it("retires the covered round on a verified boundary — fresh conversation", async () => {
    // At the 11:55 send the transcript was empty: the batch's first turn
    // persists at index 0 under the empty-prefix fingerprint. The pill-time
    // detail still holds the pre-send (empty) window; localTurns holds the
    // promoted round-1 copies.
    const b = boundary([], 0)
    seed(windowed([], 0), { localTurns: promotedRound, ...b })

    // Click 載入背景活動 → refetchDetail(preserveLive: true). The backend
    // re-parses and returns the round-1 turns PLUS the new background turn.
    const full = [userP, a1P, a2P, bgP]
    mockGetFolderConversation.mockResolvedValueOnce(windowed(full, 0))
    actions().refetchDetail(CID, { preserveLive: true })
    await flushMicrotasks()

    // The old round's promoted copies are retired (their persisted twins are
    // in the response under parser ids), so the timeline is exactly the
    // parsed transcript, newest last.
    expect(getTimelineTurns(CID).map((t) => t.turn.id)).toEqual([
      "msg_user",
      "msg_a1",
      "msg_a2",
      "msg_a3",
    ])
    expect(sessionLocalTurnIds()).toEqual([])
  })

  it("retires the covered round when the window starts before the boundary", async () => {
    // Long conversation: the pill refetch re-requests the loaded window
    // (fromIndex 0) while the batch boundary sits further in. The chain-
    // extended prefix up to the boundary still verifies, and the counts
    // after it cover the promoted round.
    const full = [...hist, userP, a1P, a2P, bgP]
    const b = boundary(full, hist.length)
    seed(windowed(hist, 0), { localTurns: promotedRound, ...b })
    mockGetFolderConversation.mockResolvedValueOnce(windowed(full, 0))
    actions().refetchDetail(CID, { preserveLive: true })
    await flushMicrotasks()
    expect(getTimelineTurns(CID).map((t) => t.turn.id)).toEqual(
      full.map((t) => t.id)
    )
    expect(sessionLocalTurnIds()).toEqual([])
  })

  it("keeps the reply whose record has not flushed (review repro)", async () => {
    // Settled-but-unflushed: the turn ended, the reply's record is not on
    // disk, and the response's tail is the round's OWN prompt — whose
    // agent-clock timestamp reads "newer" than the promoted reply (stamped
    // with the round start). The assistant count after the boundary (0)
    // cannot cover the local reply (1), so the promoted copy — the ONLY
    // copy — must stay.
    const b = boundary(hist, hist.length)
    seed(windowed(hist, 0), {
      localTurns: [
        turn(`live-${CID}-m0`, "user", T0),
        turn(`live-${CID}-m1`, "assistant", "2026-11-18T03:55:01.005Z"),
      ],
      ...b,
    })
    const promptP = turn("msg_user2", "user", "2026-11-18T03:55:01.040Z")
    mockGetFolderConversation.mockResolvedValueOnce(
      windowed([...hist, promptP], 0)
    )
    actions().refetchDetail(CID, { preserveLive: true })
    await flushMicrotasks()
    expect(sessionLocalTurnIds()).toEqual([`live-${CID}-m0`, `live-${CID}-m1`])
    expect(getTimelineTurns(CID).map((t) => t.turn.id)).toContain(
      `live-${CID}-m1`
    )
  })

  it("keeps the still-unflushed last group of a multi-group round", async () => {
    // First group flushed, last group not: the counts after the boundary
    // cover only one of the two local assistant turns.
    const b = boundary(hist, hist.length)
    const promptP = turn("msg_user2", "user", T0)
    const a1P2 = turn("msg_a1x", "assistant", T1)
    seed(windowed(hist, 0), {
      localTurns: [
        turn(`live-${CID}-m0`, "user", T0),
        turn(`live-${CID}-m1`, "assistant", T1),
        turn(`live-${CID}-m2`, "assistant", T2),
      ],
      ...b,
    })
    mockGetFolderConversation.mockResolvedValueOnce(
      windowed([...hist, promptP, a1P2], 0)
    )
    actions().refetchDetail(CID, { preserveLive: true })
    await flushMicrotasks()
    expect(sessionLocalTurnIds()).toHaveLength(3)
  })

  it("keeps everything while the batch has not reached the disk at all", async () => {
    const b = boundary(hist, hist.length)
    seed(windowed(hist, 0), {
      localTurns: [
        turn(`live-${CID}-m0`, "user", T0),
        turn(`live-${CID}-m1`, "assistant", T1),
      ],
      ...b,
    })
    mockGetFolderConversation.mockResolvedValueOnce(windowed(hist, 0))
    actions().refetchDetail(CID, { preserveLive: true })
    await flushMicrotasks()
    expect(sessionLocalTurnIds()).toHaveLength(2)
  })

  it("keeps everything when the anchored prefix was rewritten (compaction)", async () => {
    // The boundary fingerprint was captured over `hist`; the response's
    // prefix at the same index carries different turns.
    const b = boundary(hist, hist.length)
    const rewritten = [
      turn("msg_cx", "user", "2026-11-18T02:00:00.000Z"),
      turn("msg_cy", "assistant", "2026-11-18T02:00:05.000Z"),
    ]
    seed(windowed(hist, 0), { localTurns: promotedRound, ...b })
    mockGetFolderConversation.mockResolvedValueOnce(
      windowed([...rewritten, userP, a1P, a2P, bgP], 0)
    )
    actions().refetchDetail(CID, { preserveLive: true })
    await flushMicrotasks()
    expect(sessionLocalTurnIds()).toEqual(promotedIds)
  })

  it("keeps everything when a background turn landed AT the boundary", async () => {
    // An out-of-turn background turn completed inside the send→persist
    // window, so the turn at the boundary is not this batch's prompt — the
    // alignment is not this batch's, whatever the counts say.
    const b = boundary(hist, hist.length)
    const promptP = turn("msg_user2", "user", T0)
    const bgEarly = turn("msg_bg_early", "assistant", T0)
    const a1P2 = turn("msg_a1x", "assistant", T1)
    seed(windowed(hist, 0), {
      localTurns: [
        turn(`live-${CID}-m0`, "user", T0),
        turn(`live-${CID}-m1`, "assistant", T1),
      ],
      ...b,
    })
    mockGetFolderConversation.mockResolvedValueOnce(
      windowed([...hist, bgEarly, promptP, a1P2], 0)
    )
    actions().refetchDetail(CID, { preserveLive: true })
    await flushMicrotasks()
    expect(sessionLocalTurnIds()).toHaveLength(2)
  })

  it("keeps everything when the window starts past the boundary", async () => {
    const full = [...hist, userP, a1P, a2P, bgP]
    const b = boundary(full, hist.length)
    seed(windowed(full, 4), { localTurns: promotedRound, ...b })
    // The response's window (offset 4) does not reach back to the boundary
    // (index 2) — the prefix up to it cannot be verified.
    mockGetFolderConversation.mockResolvedValueOnce(windowed(full, 4))
    actions().refetchDetail(CID, { preserveLive: true })
    await flushMicrotasks()
    expect(sessionLocalTurnIds()).toEqual(promotedIds)
  })

  it("keeps everything when no batch boundary was ever captured", async () => {
    // A pure viewer never sends, so nothing captured a boundary: retirement
    // has no anchor and must not guess.
    seed(windowed([], 0), { localTurns: promotedRound })
    mockGetFolderConversation.mockResolvedValueOnce(
      windowed([userP, a1P, a2P, bgP], 0)
    )
    actions().refetchDetail(CID, { preserveLive: true })
    await flushMicrotasks()
    expect(sessionLocalTurnIds()).toEqual(promotedIds)
  })

  it("keeps everything when the response is a mid-turn (in-flight) snapshot", async () => {
    const full = [userP, a1P, a2P, bgP]
    seed(windowed([], 0), {
      localTurns: promotedRound,
      ...boundary([], 0),
    })
    mockGetFolderConversation.mockResolvedValueOnce(
      windowed(full, 0, { in_flight_user_turn_id: "msg_user" })
    )
    actions().refetchDetail(CID, { preserveLive: true })
    await flushMicrotasks()
    expect(sessionLocalTurnIds()).toEqual(promotedIds)
  })

  it("keeps everything while a live message is attached", async () => {
    const full = [userP, a1P, a2P, bgP]
    seed(windowed([], 0), {
      localTurns: promotedRound,
      ...boundary([], 0),
      liveMessage: {
        id: "lm",
        role: "assistant",
        content: [{ type: "text", text: "streaming" }],
        startedAt: Date.parse(T3),
      },
    })
    mockGetFolderConversation.mockResolvedValueOnce(windowed(full, 0))
    actions().refetchDetail(CID, { preserveLive: true })
    await flushMicrotasks()
    expect(sessionLocalTurnIds()).toEqual(promotedIds)
  })

  it("keeps everything when the sub-agent dialog owns the turn", async () => {
    const full = [userP, a1P, a2P, bgP]
    seed(windowed([], 0), {
      localTurns: promotedRound,
      ...boundary([], 0),
      liveOwnsActiveTurn: true,
    })
    mockGetFolderConversation.mockResolvedValueOnce(windowed(full, 0))
    actions().refetchDetail(CID, { preserveLive: true })
    await flushMicrotasks()
    expect(sessionLocalTurnIds()).toEqual(promotedIds)
  })

  it("a plain refetch (no preserveLive) clears the promoted round and keeps order", async () => {
    const full = [userP, a1P, a2P, bgP]
    seed(windowed([], 0), {
      localTurns: promotedRound,
      ...boundary([], 0),
    })
    mockGetFolderConversation.mockResolvedValueOnce(windowed(full, 0))
    actions().refetchDetail(CID)
    await flushMicrotasks()
    expect(getTimelineTurns(CID).map((t) => t.turn.id)).toEqual([
      "msg_user",
      "msg_a1",
      "msg_a2",
      "msg_a3",
    ])
    expect(sessionLocalTurnIds()).toEqual([])
  })
})
