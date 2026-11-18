/**
 * The "Load background activity" pill (out-of-turn wire content) refetches
 * with `preserveLive: true`. The promoted round it keeps in `localTurns` can
 * be one the refreshed detail now covers — an OpenCode background sub-agent
 * round is the canonical case (see FETCH_DETAIL_SUCCESS in
 * conversation-runtime-store): the foreground round completed and promoted
 * long before the background round ran, so its persisted twin is in the new
 * parse under a parser id (`msg_…`) `dedupeTimeline` can never match against
 * the promoted `live-<cid>-…` id. Before the coverage retirement, keeping it
 * rendered the whole old round a second time BELOW the newer persisted tail,
 * which read as "the newest messages jumped to the top".
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
import type { DbConversationDetail, MessageTurn } from "@/lib/types"

vi.mock("@/lib/api", () => ({
  getFolderConversation: vi.fn(),
}))

const { getFolderConversation } = await import("@/lib/api")
const mockGetFolderConversation = vi.mocked(getFolderConversation)

const CID = 7

const T0 = "2026-11-18T03:55:01.000Z" // user asks (11:55 local)
const T1 = "2026-11-18T03:55:11.000Z" // subagent launch turn
const T2 = "2026-11-18T03:55:18.000Z" // "working in background" ack, turn ends
const T3 = "2026-11-18T04:02:50.000Z" // child finished → parent's follow-up

function turn(id: string, role: "user" | "assistant", ts: string): MessageTurn {
  return { id, role, blocks: [{ type: "text", text: id }], timestamp: ts }
}

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

function detail(
  turns: MessageTurn[],
  overrides: Partial<DbConversationDetail> = {}
): DbConversationDetail {
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
      message_count: turns.length,
      child_count: 0,
      created_at: T0,
      updated_at: T3,
      pinned_at: null,
    },
    turns,
    in_flight_user_turn_id: null,
    ...overrides,
  }
}

function seed(
  currentDetail: DbConversationDetail,
  overrides: {
    localTurns?: MessageTurn[]
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
    batchBoundaryIndex: null,
    batchBoundaryPrefixHash: null,
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

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  resetConversationRuntimeStore()
  mockGetFolderConversation.mockReset()
})

afterEach(() => {
  resetConversationRuntimeStore()
})

describe("load-background-activity pill refetch (preserveLive)", () => {
  it("retires the promoted round the refreshed detail covers — no duplicate below the new tail", async () => {
    // State at pill time: round 1 is promoted into localTurns (it completed at
    // 11:55); the out-of-turn background round was dropped by the wire guard
    // and exists only in the transcript. detail still holds the old parse.
    seed(detail([userP, a1P, a2P]), { localTurns: promotedRound })

    // Click 載入背景活動 → refetchDetail(preserveLive: true). The backend
    // re-parses and returns the round-1 turns PLUS the new background turn.
    mockGetFolderConversation.mockResolvedValueOnce(
      detail([userP, a1P, a2P, bgP])
    )
    actions().refetchDetail(CID, { preserveLive: true })
    await flushMicrotasks()

    // The old round's promoted copies are retired (their persisted twins are
    // in the response under parser ids), so the timeline is exactly the
    // parsed transcript, newest last — the newest messages no longer render
    // above a duplicated old round.
    expect(getTimelineTurns(CID).map((t) => t.turn.id)).toEqual([
      "msg_user",
      "msg_a1",
      "msg_a2",
      "msg_a3",
    ])
    expect(sessionLocalTurnIds()).toEqual([])
  })

  it("a plain refetch (no preserveLive) clears the promoted round and keeps order", async () => {
    seed(detail([userP, a1P, a2P]), { localTurns: promotedRound })
    mockGetFolderConversation.mockResolvedValueOnce(
      detail([userP, a1P, a2P, bgP])
    )
    actions().refetchDetail(CID)
    await flushMicrotasks()
    expect(getTimelineTurns(CID).map((t) => t.turn.id)).toEqual([
      "msg_user",
      "msg_a1",
      "msg_a2",
      "msg_a3",
    ])
  })

  it("keeps the promoted round while its persisted twin has not landed (write race)", async () => {
    // The response walked the transcript BEFORE this round: nothing in it is
    // strictly newer than the promoted round, so retirement cannot prove
    // coverage — the promoted copy must survive (`completeTurn`'s
    // transcript-write race).
    const raceUser = turn(`live-${CID}-m0`, "user", T2)
    const raceA = turn(`live-${CID}-m1`, "assistant", T3)
    seed(detail([userP, a1P]), { localTurns: [raceUser, raceA] })
    mockGetFolderConversation.mockResolvedValueOnce(detail([userP, a1P]))
    actions().refetchDetail(CID, { preserveLive: true })
    await flushMicrotasks()
    expect(sessionLocalTurnIds()).toEqual([`live-${CID}-m0`, `live-${CID}-m1`])
  })

  it("keeps the promoted round when the response is a mid-turn (in-flight) snapshot", async () => {
    seed(detail([userP, a1P, a2P]), { localTurns: promotedRound })
    mockGetFolderConversation.mockResolvedValueOnce(
      detail([userP, a1P, a2P, bgP], { in_flight_user_turn_id: "msg_user" })
    )
    actions().refetchDetail(CID, { preserveLive: true })
    await flushMicrotasks()
    expect(sessionLocalTurnIds()).toEqual(promotedIds)
  })

  it("keeps the promoted round while a live message is attached (turn the user started meanwhile)", async () => {
    seed(detail([userP, a1P, a2P]), {
      localTurns: promotedRound,
      liveMessage: {
        id: "lm",
        role: "assistant",
        content: [{ type: "text", text: "streaming" }],
        startedAt: Date.parse(T3),
      },
    })
    mockGetFolderConversation.mockResolvedValueOnce(
      detail([userP, a1P, a2P, bgP])
    )
    actions().refetchDetail(CID, { preserveLive: true })
    await flushMicrotasks()
    expect(sessionLocalTurnIds()).toEqual(promotedIds)
  })

  it("keeps the promoted round when the sub-agent dialog owns the turn", async () => {
    // `liveOwnsActiveTurn` (sub-agent session dialog): the dialog owns its
    // promotion/dedup path — the refetch must not retire its local turns.
    seed(detail([userP, a1P, a2P, bgP]), {
      localTurns: promotedRound,
      liveOwnsActiveTurn: true,
    })
    mockGetFolderConversation.mockResolvedValueOnce(
      detail([userP, a1P, a2P, bgP])
    )
    actions().refetchDetail(CID, { preserveLive: true })
    await flushMicrotasks()
    expect(sessionLocalTurnIds()).toEqual(promotedIds)
  })

  it("keeps a promoted turn whose persisted twin can only be in the uncovered prefix", async () => {
    // Windowed response: the window starts AFTER the promoted round, so its
    // twin lives in the uncovered prefix — retiring it would vanish it.
    const windowed = detail([bgP], {
      turns_offset: 3,
      turns_total: 4,
      uncovered_prefix_max_ts: T2,
    })
    seed(windowed, { localTurns: promotedRound })
    mockGetFolderConversation.mockResolvedValueOnce(windowed)
    actions().refetchDetail(CID, { preserveLive: true })
    await flushMicrotasks()
    expect(sessionLocalTurnIds()).toEqual(promotedIds)
  })

  it("keeps a promoted turn with an unparseable timestamp", async () => {
    seed(detail([userP, a1P, a2P]), {
      localTurns: [turn("live-weird", "assistant", "not-a-date")],
    })
    mockGetFolderConversation.mockResolvedValueOnce(
      detail([userP, a1P, a2P, bgP])
    )
    actions().refetchDetail(CID, { preserveLive: true })
    await flushMicrotasks()
    expect(sessionLocalTurnIds()).toEqual(["live-weird"])
  })
})
