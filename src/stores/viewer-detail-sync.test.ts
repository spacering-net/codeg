/**
 * Coverage for `syncViewerDetail` — the cross-client fix for "a short reply
 * completed on another client never appears here".
 *
 * A client that is only VIEWING a conversation (another client owns the live
 * agent) has no live promotion path for a completed turn: the panel promotes on
 * the connection's `prompting → connected` edge, which a viewer that missed the
 * short live stream never observes, and the global `conversation://changed`
 * side-channel only patches the sidebar — not the open detail. `syncViewerDetail`
 * closes that gap by polling the persisted transcript, and:
 *   - refuses to touch an OWNER (its in-memory reply is fresher than any disk
 *     read that could race the transcript flush), and
 *   - keeps polling while the transcript still ends at the user prompt (the
 *     reply hasn't been flushed yet), stopping once the assistant reply lands.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DbConversationDetail, MessageTurn } from "@/lib/types"
import type { LiveMessage } from "@/contexts/acp-connections-context"
import {
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
  type ConversationRuntimeSession,
} from "@/stores/conversation-runtime-store"

vi.mock("@/lib/api", () => ({
  getFolderConversation: vi.fn(),
}))

const { getFolderConversation } = await import("@/lib/api")
const mockGet = vi.mocked(getFolderConversation)

const CID = 99

function userTurn(id: string, text: string): MessageTurn {
  return { id, role: "user", blocks: [{ type: "text", text }], timestamp: "" }
}

function assistantTurn(id: string, text: string): MessageTurn {
  return {
    id,
    role: "assistant",
    blocks: [{ type: "text", text }],
    timestamp: "",
  }
}

function detail(
  turns: MessageTurn[],
  watermark: number | null = null,
  inFlightUserTurnId: string | null = null
): DbConversationDetail {
  return {
    summary: {
      id: CID,
      folder_id: 1,
      agent_type: "claude_code",
      title: null,
      title_locked: false,
      status: "in_progress",
      kind: "regular",
      model: null,
      git_branch: null,
      external_id: "ext-1",
      message_count: turns.length,
      child_count: 0,
      created_at: "2026-07-18T00:00:00.000Z",
      updated_at: "2026-07-18T00:00:00.000Z",
      pinned_at: null,
    },
    turns,
    session_stats: null,
    transcript_watermark: watermark,
    in_flight_user_turn_id: inFlightUserTurnId,
  }
}

const liveMsg: LiveMessage = {
  id: "lm-1",
  role: "assistant",
  content: [],
  startedAt: 0,
}

function emptySession(conversationId: number): ConversationRuntimeSession {
  return {
    conversationId,
    externalId: "ext-1",
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
    syncState: "idle",
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
}

function seed(overrides: Partial<ConversationRuntimeSession>): void {
  useConversationRuntimeStore.setState({
    byConversationId: new Map([[CID, { ...emptySession(CID), ...overrides }]]),
  })
}

function session(): ConversationRuntimeSession | undefined {
  return useConversationRuntimeStore.getState().byConversationId.get(CID)
}

function sync(): void {
  useConversationRuntimeStore.getState().actions.syncViewerDetail(CID)
}

beforeEach(() => {
  resetConversationRuntimeStore()
  mockGet.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("syncViewerDetail — owner/guard no-ops", () => {
  it("no-ops when the conversation is not open (no runtime session)", () => {
    sync()
    expect(mockGet).not.toHaveBeenCalled()
  })

  it("no-ops for an owner mid-send (awaiting_persist)", () => {
    seed({
      syncState: "awaiting_persist",
      optimisticTurns: [userTurn("u", "hi")],
    })
    sync()
    expect(mockGet).not.toHaveBeenCalled()
  })

  it("no-ops for an owner still streaming (liveMessage present)", () => {
    seed({ liveMessage: liveMsg })
    sync()
    expect(mockGet).not.toHaveBeenCalled()
  })

  it("no-ops for an owner that just promoted its reply (localTurns + lastTurnOwned)", () => {
    // An OWNER's promoted reply may not be flushed to the transcript yet, so it
    // is protected — `lastTurnOwned` marks it as owner-driven.
    seed({ localTurns: [assistantTurn("a", "done")], lastTurnOwned: true })
    sync()
    expect(mockGet).not.toHaveBeenCalled()
  })

  it("no-ops for a delegation-child dialog that adopted its reply (liveOwnsActiveTurn + localTurns)", async () => {
    vi.useFakeTimers()
    // A sub-agent dialog adopts the child's reply from the wire BEFORE the DB
    // catches up (`liveOwnsActiveTurn`), promoting it into `localTurns` with
    // lastTurnOwned=false (no owner send). A background transcript read that
    // still lacks (or only partially has) that reply must NOT clobber it — the
    // dialog owns its own promotion/dedup path.
    seed({
      liveOwnsActiveTurn: true,
      localTurns: [assistantTurn("a", "child reply")],
      lastTurnOwned: false,
    })
    mockGet.mockResolvedValue(detail([userTurn("u", "kickoff")], null, "u"))

    sync()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mockGet).not.toHaveBeenCalled()
  })

  it("DOES sync a marker-only delegation child (liveOwnsActiveTurn, no promoted reply)", async () => {
    vi.useFakeTimers()
    // The no-child-connection fallback opens the dialog and marks the session
    // live-owned, but nothing streams or promotes (localTurns empty, no
    // liveMessage). With nothing to protect, a completion nudge must still be
    // able to fold the child's finished reply from the transcript — otherwise the
    // dialog is stranded on its stale mount fetch until reopen.
    seed({
      liveOwnsActiveTurn: true,
      localTurns: [],
      detail: detail([userTurn("u", "kickoff")], null, "u"),
    })
    mockGet.mockResolvedValue(
      detail(
        [userTurn("u", "kickoff"), assistantTurn("a", "child reply")],
        null
      )
    )

    sync()
    await vi.advanceTimersByTimeAsync(0)

    expect(mockGet).toHaveBeenCalledTimes(1)
    expect((session()?.detail?.turns ?? []).map((t) => t.role)).toEqual([
      "user",
      "assistant",
    ])
  })

  it("DOES sync a viewer that streamed an earlier turn (localTurns, not owned)", async () => {
    vi.useFakeTimers()
    // A viewer promotes captured replies into `localTurns` too, but they are
    // already persisted (lastTurnOwned stays false). Such a viewer must still be
    // able to poll for a LATER short reply it missed — otherwise it strands after
    // its first captured turn, reproducing the original bug.
    seed({
      localTurns: [userTurn("u1", "hi"), assistantTurn("a1", "hello")],
      lastTurnOwned: false,
      detail: detail([userTurn("u1", "hi"), assistantTurn("a1", "hello")], 20),
    })
    mockGet.mockResolvedValue(
      detail(
        [
          userTurn("u1", "hi"),
          assistantTurn("a1", "hello"),
          userTurn("u2", "thanks"),
          assistantTurn("a2", "you're welcome"),
        ],
        60
      )
    )

    sync()
    await vi.advanceTimersByTimeAsync(0)

    expect(mockGet).toHaveBeenCalledTimes(1)
    expect((session()?.detail?.turns ?? []).map((t) => t.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ])
  })
})

describe("syncViewerDetail — pure viewer refetch", () => {
  it("lands a completed reply on the first fetch and does not schedule a retry", async () => {
    vi.useFakeTimers()
    // Pure viewer showing only the synthesized user prompt (optimistic, NOT
    // awaiting_persist — the viewer didn't send).
    seed({
      optimisticTurns: [userTurn("u", "hi")],
      detail: detail([userTurn("u", "hi")], 10),
    })
    mockGet.mockResolvedValue(
      detail([userTurn("u", "hi"), assistantTurn("a", "Hi! …")], 42)
    )

    sync()
    await vi.advanceTimersByTimeAsync(0)

    expect(mockGet).toHaveBeenCalledTimes(1)
    expect(mockGet).toHaveBeenCalledWith(CID, { tailTurns: 120 })
    const turns = session()?.detail?.turns ?? []
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant"])
    // The persisted load replaces the synthesized optimistic prompt.
    expect(session()?.optimisticTurns).toEqual([])

    // A trailing assistant reply means "nothing left to wait for" — no retry.
    await vi.advanceTimersByTimeAsync(5000)
    expect(mockGet).toHaveBeenCalledTimes(1)
  })

  it("polls while the transcript still ends at the user prompt, then stops once the reply flushes", async () => {
    vi.useFakeTimers()
    seed({
      optimisticTurns: [userTurn("u", "hi")],
      detail: detail([userTurn("u", "hi")], 10),
    })
    // Attempt 0: reply not flushed yet (transcript still ends at the prompt).
    // Attempt 1: reply landed.
    mockGet
      .mockResolvedValueOnce(detail([userTurn("u", "hi")], 10))
      .mockResolvedValueOnce(
        detail([userTurn("u", "hi"), assistantTurn("a", "Hi! …")], 42)
      )

    sync()
    await vi.advanceTimersByTimeAsync(0)
    expect(mockGet).toHaveBeenCalledTimes(1)
    // Still only the prompt — reply not surfaced yet.
    expect((session()?.detail?.turns ?? []).map((t) => t.role)).toEqual([
      "user",
    ])

    // Second attempt fires after the first backoff delay.
    await vi.advanceTimersByTimeAsync(300)
    expect(mockGet).toHaveBeenCalledTimes(2)
    expect((session()?.detail?.turns ?? []).map((t) => t.role)).toEqual([
      "user",
      "assistant",
    ])

    // Converged — no further polling.
    await vi.advanceTimersByTimeAsync(5000)
    expect(mockGet).toHaveBeenCalledTimes(2)
  })

  it("keeps polling while the turn is in flight even if the tail is a partial assistant turn", async () => {
    vi.useFakeTimers()
    seed({
      optimisticTurns: [userTurn("u", "hi")],
      detail: detail([userTurn("u", "hi")], 10),
    })
    // OpenCode/Gemini shape: a PARTIAL assistant turn is persisted mid-stream,
    // so the tail is already `assistant`, but the backend still reports the turn
    // as in flight — a role-only check would stop early and miss the final reply.
    mockGet
      .mockResolvedValueOnce(
        detail([userTurn("u", "hi"), assistantTurn("a", "Hi")], 20, "u")
      )
      .mockResolvedValueOnce(
        detail([userTurn("u", "hi"), assistantTurn("a", "Hi! …")], 42, null)
      )

    sync()
    await vi.advanceTimersByTimeAsync(0)
    expect(mockGet).toHaveBeenCalledTimes(1)

    // The in-flight flag kept the poll going despite the assistant tail.
    await vi.advanceTimersByTimeAsync(300)
    expect(mockGet).toHaveBeenCalledTimes(2)
    expect((session()?.detail?.turns ?? []).map((t) => t.role)).toEqual([
      "user",
      "assistant",
    ])

    await vi.advanceTimersByTimeAsync(5000)
    expect(mockGet).toHaveBeenCalledTimes(2)
  })

  it("gives up after a bounded number of attempts when the reply never lands", async () => {
    vi.useFakeTimers()
    seed({ detail: detail([userTurn("u", "hi")], 10) })
    // Every read still ends at the user prompt (e.g. a cancelled turn).
    mockGet.mockResolvedValue(detail([userTurn("u", "hi")], 10))

    sync()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10_000)
    // 5 delays configured → at most 5 attempts, then it stops for good.
    expect(mockGet).toHaveBeenCalledTimes(5)
  })

  it("does not commit its read when a concurrent panel fetch superseded the generation", async () => {
    vi.useFakeTimers()
    seed({ detail: detail([userTurn("u", "hi")], 10) })
    mockGet
      // attempt 0: a reply-pending read that will be superseded before it lands.
      .mockResolvedValueOnce(detail([userTurn("u", "hi")], 20))
      // the concurrent panel refetch — never resolves, just owns the generation.
      .mockImplementation(() => new Promise<DbConversationDetail>(() => {}))

    sync()
    // A panel refetch bumps the shared fetch generation before attempt 0 lands.
    useConversationRuntimeStore.getState().actions.refetchDetail(CID)
    await vi.advanceTimersByTimeAsync(0)

    // attempt 0 resolved but was superseded → it must NOT clobber the detail the
    // panel refetch now owns (watermark stays at the seeded 10, not 20).
    expect(session()?.detail?.transcript_watermark).toBe(10)
  })

  it("fetches by dbConversationId when the runtime key is a virtual id", async () => {
    vi.useFakeTimers()
    useConversationRuntimeStore.setState({
      byConversationId: new Map([
        [
          -7,
          {
            ...emptySession(-7),
            dbConversationId: 500,
            detail: detail([userTurn("u", "hi")], 10),
            optimisticTurns: [userTurn("u", "hi")],
          },
        ],
      ]),
    })
    mockGet.mockResolvedValue(
      detail([userTurn("u", "hi"), assistantTurn("a", "Hi! …")], 42)
    )

    useConversationRuntimeStore.getState().actions.syncViewerDetail(-7)
    await vi.advanceTimersByTimeAsync(0)
    expect(mockGet).toHaveBeenCalledWith(500, { tailTurns: 120 })
  })

  it("routes a positive-id nudge to a draft tab keyed by a negative runtime id", async () => {
    vi.useFakeTimers()
    // A draft-originated tab keeps its virtual (negative) runtime key while
    // storing the positive DB id in `dbConversationId`. The `conversation://
    // changed` nudge carries the positive id, so the action must reverse-resolve
    // it to the negative-keyed session (a direct lookup would miss it entirely).
    useConversationRuntimeStore.setState({
      byConversationId: new Map([
        [
          -7,
          {
            ...emptySession(-7),
            dbConversationId: CID,
            detail: detail([userTurn("u", "hi")], 10),
            optimisticTurns: [userTurn("u", "hi")],
          },
        ],
      ]),
    })
    mockGet.mockResolvedValue(
      detail([userTurn("u", "hi"), assistantTurn("a", "Hi! …")], 42)
    )

    // Nudge with the POSITIVE db id, exactly as the workspace side-channel does.
    useConversationRuntimeStore.getState().actions.syncViewerDetail(CID)
    await vi.advanceTimersByTimeAsync(0)

    expect(mockGet).toHaveBeenCalledWith(CID, { tailTurns: 120 })
    const turns =
      useConversationRuntimeStore.getState().byConversationId.get(-7)?.detail
        ?.turns ?? []
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant"])
  })

  it("commits the final reply of a no-watermark agent that grew a partial in place", async () => {
    vi.useFakeTimers()
    // OpenCode/Gemini have no transcript watermark and rewrite the SAME assistant
    // turn in place as it grows. The partial and the final read therefore share a
    // null watermark AND turn count, so the byte/count `changed` guard can't tell
    // them apart — only the settle transition (`in_flight` clearing) can. Without
    // a settle-commit the viewer would freeze on the partial.
    seed({
      optimisticTurns: [userTurn("u", "hi")],
      detail: detail([userTurn("u", "hi")], null),
    })
    mockGet
      // Attempt 0: a partial assistant turn, still in flight → commits (count
      // grew from 1 to 2) and keeps polling.
      .mockResolvedValueOnce(
        detail([userTurn("u", "hi"), assistantTurn("a", "Hi")], null, "u")
      )
      // Attempt 1: the FINAL content, settled (in_flight cleared). Same null
      // watermark AND same turn count as attempt 0 → `changed` is false; only the
      // settle-commit lands it.
      .mockResolvedValueOnce(
        detail(
          [
            userTurn("u", "hi"),
            assistantTurn("a", "Hi there, how can I help?"),
          ],
          null,
          null
        )
      )

    sync()
    await vi.advanceTimersByTimeAsync(0)
    expect(mockGet).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(300)
    expect(mockGet).toHaveBeenCalledTimes(2)
    const turns = session()?.detail?.turns ?? []
    const lastText = turns[turns.length - 1]?.blocks?.[0]
    expect(lastText?.type === "text" ? lastText.text : null).toBe(
      "Hi there, how can I help?"
    )

    // Converged after the settle-commit — no further polling.
    await vi.advanceTimersByTimeAsync(5000)
    expect(mockGet).toHaveBeenCalledTimes(2)
  })
})

describe("syncViewerDetail — cancellation", () => {
  it("removeConversation cancels a pending poll (no further fetch)", async () => {
    vi.useFakeTimers()
    seed({ detail: detail([userTurn("u", "hi")], 10) })
    mockGet.mockResolvedValue(detail([userTurn("u", "hi")], 10)) // stays pending

    sync()
    await vi.advanceTimersByTimeAsync(0)
    expect(mockGet).toHaveBeenCalledTimes(1)

    useConversationRuntimeStore.getState().actions.removeConversation(CID)
    await vi.advanceTimersByTimeAsync(10_000)
    // The scheduled retry was cancelled with the tab.
    expect(mockGet).toHaveBeenCalledTimes(1)
  })

  it("stops polling if the viewer starts its own turn mid-poll", async () => {
    vi.useFakeTimers()
    seed({ detail: detail([userTurn("u", "hi")], 10) })
    mockGet.mockResolvedValue(detail([userTurn("u", "hi")], 10))

    sync()
    await vi.advanceTimersByTimeAsync(0)
    expect(mockGet).toHaveBeenCalledTimes(1)

    // The viewer becomes an owner (local send → awaiting_persist). The next
    // tick's pure-viewer guard must abort the poll.
    seed({
      detail: detail([userTurn("u", "hi")], 10),
      syncState: "awaiting_persist",
      optimisticTurns: [userTurn("u2", "again")],
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mockGet).toHaveBeenCalledTimes(1)
  })
})
