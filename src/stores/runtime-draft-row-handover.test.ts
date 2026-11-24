/**
 * The draft → row hand-off, from the runtime store's side.
 *
 * A conversation card on the canvas that has never been sent to has no row, so
 * its surface streams under a VIRTUAL (negative) runtime id derived from its
 * connection key. The first send mints the row — and on the canvas that swaps
 * the card itself: the draft node goes away and a pinned card takes its place,
 * mounted on the real conversation id. (The tab strip never has to do this; a
 * draft tab keeps its virtual key for the tab's whole life.)
 *
 * Everything the user has done up to that point lives in the draft's session:
 * the optimistic user turn, the reply already streaming in behind it, the
 * resolved agent session id, and the `awaiting_persist` flag that keeps the
 * next detail fetch from treating the DB as complete. `MIGRATE_CONVERSATION` is
 * how the canvas hands that session to the row (see `materializeDraft`).
 *
 * Without it the new card starts from an empty session — and the failure is
 * lopsided in a way that reads like a rendering bug rather than a lost message:
 * the live sink follows the INHERITED connection key, so the agent's answer
 * still streams in and settles normally, while the message that asked for it,
 * and the transcript it belonged to, are simply not there.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { LiveMessage } from "@/contexts/acp-connections-context"
import {
  resetConversationRuntimeStore,
  selectTimelineTurns,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"
import type { DbConversationDetail, MessageTurn } from "@/lib/types"

vi.mock("@/lib/api", () => ({
  getFolderConversation: vi.fn(),
}))

const { getFolderConversation } = await import("@/lib/api")
const mockGetFolderConversation = vi.mocked(getFolderConversation)

/** The draft's runtime id — `draftRuntimeConversationId(contextKey)`, which is
 *  always negative so it can never collide with a row. */
const DRAFT = -4211
/** The conversation the first send created. */
const ROW = 91

const SENT: MessageTurn = {
  id: "optimistic-1",
  role: "user",
  blocks: [{ type: "text", text: "add a health check to the worker" }],
  timestamp: "2026-09-02T09:00:00.000Z",
}

const REPLY: LiveMessage = {
  id: "live-1",
  role: "assistant",
  content: [{ type: "text", text: "Looking at the worker…" }],
  startedAt: Date.parse("2026-09-02T09:00:01.000Z"),
}

function actions() {
  return useConversationRuntimeStore.getState().actions
}

function session(conversationId: number) {
  return useConversationRuntimeStore
    .getState()
    .byConversationId.get(conversationId)
}

function timelineIds(conversationId: number): string[] {
  return selectTimelineTurns(
    useConversationRuntimeStore.getState(),
    conversationId
  ).map((t) => t.turn.id)
}

/** The state a draft card is in the instant its row lands: the prompt is on
 *  screen, the agent is answering, and the row id has just been bound. */
function seedDraftMidSend(): void {
  actions().appendOptimisticTurn(DRAFT, SENT, SENT.id)
  actions().setSyncState(DRAFT, "awaiting_persist")
  actions().setExternalId(DRAFT, "sess-draft")
  actions().setLiveMessage(DRAFT, REPLY, true)
  actions().setDbConversationId(DRAFT, ROW)
}

/** What the backend has for a conversation whose transcript hasn't been written
 *  yet — which is exactly when this refetch happens. */
function emptyDetail(): DbConversationDetail {
  return {
    summary: {
      id: ROW,
      folder_id: 1,
      title: "add a health check to the worker",
      title_locked: false,
      agent_type: "claude_code",
      status: "in_progress",
      kind: "regular",
      model: null,
      git_branch: null,
      external_id: "sess-draft",
      message_count: 0,
      child_count: 0,
      created_at: "2026-09-02T09:00:00.000Z",
      updated_at: "2026-09-02T09:00:00.000Z",
      pinned_at: null,
    },
    turns: [],
    session_stats: null,
  }
}

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  resetConversationRuntimeStore()
  mockGetFolderConversation.mockReset()
  mockGetFolderConversation.mockImplementation(() => new Promise(() => {}))
})

afterEach(() => {
  resetConversationRuntimeStore()
})

describe("handing a draft's runtime session to the row it created", () => {
  it("moves the sent message onto the row's id", () => {
    seedDraftMidSend()
    actions().migrateConversation(DRAFT, ROW)

    // The card that mounts on ROW renders the prompt and the reply in flight,
    // so it never paints the empty state on the way through. The streaming
    // turn is namespaced by conversation, so it re-keys onto the row as well.
    expect(timelineIds(ROW)).toEqual([SENT.id, `live-${ROW}-${REPLY.id}`])
    expect(session(DRAFT)).toBeUndefined()
  })

  it("carries the reply in flight rather than restarting it", () => {
    seedDraftMidSend()
    actions().migrateConversation(DRAFT, ROW)

    // The connection is mid-turn: the same live message has to be under the new
    // id before the new card's sink registers, or the round it is watching
    // would appear to begin twice.
    expect(session(ROW)?.liveMessage?.id).toBe(REPLY.id)
    expect(session(ROW)?.externalId).toBe("sess-draft")
    // Resolvable both ways — the reverse index follows the session, so an event
    // routed by agent session id still lands on this conversation.
    expect(
      useConversationRuntimeStore
        .getState()
        .conversationIdByExternalId.get("sess-draft")
    ).toBe(ROW)
  })

  it("binds the row id so a later refetch has something to fetch with", () => {
    seedDraftMidSend()
    actions().migrateConversation(DRAFT, ROW)
    expect(session(ROW)?.dbConversationId).toBe(ROW)
  })

  it("keeps awaiting_persist, so the first refetch can't erase the message", async () => {
    seedDraftMidSend()
    actions().migrateConversation(DRAFT, ROW)

    // A settled refetch is authoritative and normally clears every in-flight
    // buffer. The transcript for a just-created row is still empty at this
    // point, so a session that arrived here as "idle" would drop the user's
    // message on the floor — `awaiting_persist` is the only thing standing
    // between them.
    mockGetFolderConversation.mockResolvedValueOnce(emptyDetail())
    actions().refetchDetail(ROW, { preserveLive: false })
    await flushMicrotasks()

    expect(mockGetFolderConversation).toHaveBeenCalledWith(ROW, {
      tailTurns: 120,
    })
    expect(session(ROW)?.syncState).toBe("awaiting_persist")
    expect(timelineIds(ROW)).toContain(SENT.id)
  })

  it("leaves a late send failure rolling back against the old id alone", () => {
    // A rejected prompt is its own round trip and can land after the hand-off.
    // The rollback the surface registered names the id it was mounted with, so
    // it must be harmless there — and it must NOT resurrect the session it was
    // pointed at, which would leave a second, invisible copy of the thread.
    seedDraftMidSend()
    actions().migrateConversation(DRAFT, ROW)
    actions().removeOptimisticTurn(DRAFT, SENT.id)
    expect(session(DRAFT)).toBeUndefined()
    expect(timelineIds(ROW)).toContain(SENT.id)

    // Naming the row is what actually rolls it back — and that also clears
    // `awaiting_persist`, so the card stops showing a typing indicator under a
    // message that was never delivered.
    actions().removeOptimisticTurn(ROW, SENT.id)
    expect(timelineIds(ROW)).not.toContain(SENT.id)
    expect(session(ROW)?.syncState).toBe("idle")
  })

  it("is inert when there is no draft session to hand over", () => {
    // The pinned card calls this on a key that never held a draft (a board
    // restored from a previous visit, a card whose draft was already reaped).
    // It must leave the row's own session exactly as it found it rather than
    // replacing it with an empty one.
    actions().appendOptimisticTurn(ROW, SENT, SENT.id)
    const before = session(ROW)
    actions().migrateConversation(-999, ROW)
    expect(session(ROW)).toBe(before)
    expect(session(-999)).toBeUndefined()
  })
})
