/**
 * `refetchDetail` resolves to whether ITS response landed in the store.
 *
 * Most callers fire and forget. The wake resync cannot: it collapses the
 * triggers of one wake (page shown, transport reconnected) into a single
 * refetch, and a refetch issued while the link was still down fails — so it
 * must be told, or the reconnect that follows would be swallowed as a
 * duplicate of a read that never got through.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"
import type { DbConversationDetail } from "@/lib/types"

vi.mock("@/lib/api", () => ({
  getFolderConversation: vi.fn(),
}))

const { getFolderConversation } = await import("@/lib/api")
const mockGetFolderConversation = vi.mocked(getFolderConversation)

const CID = 7

function detail(externalId: string): DbConversationDetail {
  return {
    summary: {
      id: CID,
      folder_id: 1,
      agent_type: "claude_code",
      title: "t",
      title_locked: false,
      status: "completed",
      kind: "regular",
      model: null,
      git_branch: null,
      external_id: externalId,
      message_count: 0,
      child_count: 0,
      created_at: "2026-09-24T10:00:00.000Z",
      updated_at: "2026-09-24T10:00:00.000Z",
      pinned_at: null,
    },
    turns: [],
    session_stats: null,
  }
}

function actions() {
  return useConversationRuntimeStore.getState().actions
}

function loadedExternalId() {
  return (
    useConversationRuntimeStore.getState().byConversationId.get(CID)?.detail
      ?.summary.external_id ?? null
  )
}

beforeEach(() => {
  resetConversationRuntimeStore()
  mockGetFolderConversation.mockReset()
})

afterEach(() => {
  resetConversationRuntimeStore()
})

describe("refetchDetail result", () => {
  it("resolves true once its response is in the store", async () => {
    mockGetFolderConversation.mockResolvedValueOnce(detail("session-2"))
    await expect(actions().refetchDetail(CID)).resolves.toBe(true)
    expect(loadedExternalId()).toBe("session-2")
  })

  it("resolves false when a later fetch superseded it", async () => {
    let releaseFirst: (d: DbConversationDetail) => void = () => {}
    mockGetFolderConversation
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = resolve
          })
      )
      .mockResolvedValueOnce(detail("session-2"))

    const first = actions().refetchDetail(CID)
    const second = actions().refetchDetail(CID)
    await expect(second).resolves.toBe(true)
    // The older response arrives last — and is dropped, which its caller
    // must be able to tell.
    releaseFirst(detail("session-1"))
    await expect(first).resolves.toBe(false)
    expect(loadedExternalId()).toBe("session-2")
  })

  it("resolves false — never rejects — when the fetch fails", async () => {
    mockGetFolderConversation.mockRejectedValueOnce(new Error("offline"))
    await expect(actions().refetchDetail(CID)).resolves.toBe(false)
    expect(
      useConversationRuntimeStore.getState().byConversationId.get(CID)
        ?.detailError
    ).toBe("offline")
  })
})
