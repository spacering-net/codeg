import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DbConversationSummary } from "@/lib/types"

vi.mock("@/lib/api", () => ({
  getFolder: vi.fn(),
  getGitHead: vi.fn(),
  listOpenFolderDetails: vi.fn(async () => []),
  listAllFolderDetails: vi.fn(async () => []),
  listFolderGroups: vi.fn(async () => []),
  listAllConversations: vi.fn(async () => []),
  openFolder: vi.fn(),
  openFolderById: vi.fn(),
  openWorktreeFolder: vi.fn(),
  removeFolderFromWorkspace: vi.fn(),
  applySidebarLayout: vi.fn(),
  createFolderGroup: vi.fn(),
  updateFolderGroup: vi.fn(),
  deleteFolderGroup: vi.fn(),
  setFolderGroup: vi.fn(),
  updateConversationTags: vi.fn(),
}))

const api = await import("@/lib/api")
const { resetAppWorkspaceStore, useAppWorkspaceStore } =
  await import("@/stores/app-workspace-store")
const { changeConversationTags } = await import("./conversation-tag-assignment")

function summary(
  overrides: Partial<DbConversationSummary> & { id: number }
): DbConversationSummary {
  return {
    folder_id: 1,
    title: null,
    title_locked: false,
    agent_type: "claude_code",
    status: "completed",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 0,
    child_count: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    pinned_at: null,
    ...overrides,
  }
}

const row = (id: number) =>
  useAppWorkspaceStore.getState().conversations.find((c) => c.id === id)

beforeEach(() => {
  resetAppWorkspaceStore()
  vi.mocked(api.updateConversationTags).mockReset()
  vi.mocked(api.listAllConversations).mockReset()
  vi.mocked(api.listAllConversations).mockResolvedValue([])
})

describe("changeConversationTags", () => {
  it("patches the row at once, sorted, without touching updated_at", async () => {
    useAppWorkspaceStore
      .getState()
      .applyConversationUpsert(summary({ id: 1, tag_ids: [5] }))
    let settle!: () => void
    vi.mocked(api.updateConversationTags).mockReturnValueOnce(
      new Promise((resolve) => {
        settle = () => resolve(summary({ id: 1, tag_ids: [2, 5] }))
      })
    )

    const pending = changeConversationTags(1, { add: [2] })
    // Before the backend answers.
    expect(row(1)?.tag_ids).toEqual([2, 5])
    // Tagging is not activity: an "updated"-sorted folder must not reorder.
    expect(row(1)?.updated_at).toBe("2026-01-01T00:00:00.000Z")
    expect(api.updateConversationTags).toHaveBeenCalledWith({
      conversationId: 1,
      add: [2],
      remove: [],
    })
    settle()
    await pending
  })

  it("does not apply the reply — the broadcast owns the row", async () => {
    useAppWorkspaceStore
      .getState()
      .applyConversationUpsert(summary({ id: 1, tag_ids: [5] }))
    vi.mocked(api.updateConversationTags).mockImplementationOnce(async () => {
      // Another window's change, broadcast while our request was out.
      useAppWorkspaceStore
        .getState()
        .applyConversationUpsert(summary({ id: 1, tag_ids: [2, 5, 7] }))
      // Our reply was read before that write.
      return summary({ id: 1, tag_ids: [2, 5] })
    })
    await changeConversationTags(1, { add: [2] })
    expect(row(1)?.tag_ids).toEqual([2, 5, 7])
  })

  it("takes the optimistic value back on failure", async () => {
    useAppWorkspaceStore
      .getState()
      .applyConversationUpsert(summary({ id: 1, tag_ids: [5] }))
    vi.mocked(api.updateConversationTags).mockRejectedValueOnce(
      new Error("refused")
    )
    await expect(changeConversationTags(1, { remove: [5] })).rejects.toThrow(
      "refused"
    )
    expect(row(1)?.tag_ids).toEqual([5])
  })

  it("re-reads instead of reverting once a broadcast replaced the row", async () => {
    useAppWorkspaceStore
      .getState()
      .applyConversationUpsert(summary({ id: 1, tag_ids: [5] }))
    vi.mocked(api.listAllConversations).mockResolvedValueOnce([
      summary({ id: 1, tag_ids: [9] }),
    ])
    vi.mocked(api.updateConversationTags).mockImplementationOnce(async () => {
      useAppWorkspaceStore
        .getState()
        .applyConversationUpsert(summary({ id: 1, tag_ids: [9] }))
      throw new Error("refused")
    })
    await expect(changeConversationTags(1, { add: [2] })).rejects.toThrow()
    // Not rolled back to [5]: what arrived meanwhile is newer than both.
    expect(row(1)?.tag_ids).toEqual([9])
    await vi.waitFor(() => expect(api.listAllConversations).toHaveBeenCalled())
  })

  it("never undoes a change the server confirmed when only the reply failed", async () => {
    useAppWorkspaceStore.getState().applyConversationUpsert(summary({ id: 1 }))
    vi.mocked(api.listAllConversations).mockResolvedValueOnce([
      summary({ id: 1, tag_ids: [7] }),
    ])
    vi.mocked(api.updateConversationTags).mockImplementationOnce(async () => {
      // Committed and broadcast — the SAME tags as our guess, in a new row
      // object — and then the reply was lost.
      useAppWorkspaceStore
        .getState()
        .applyConversationUpsert(summary({ id: 1, tag_ids: [7] }))
      throw new Error("connection reset")
    })
    await expect(changeConversationTags(1, { add: [7] })).rejects.toThrow()
    expect(row(1)?.tag_ids).toEqual([7])
  })

  it("still asks the backend for a row the root list does not hold", async () => {
    vi.mocked(api.updateConversationTags).mockResolvedValueOnce(
      summary({ id: 3, parent_id: 1, tag_ids: [2] })
    )
    await changeConversationTags(3, { add: [2] })
    expect(api.updateConversationTags).toHaveBeenCalledTimes(1)
    expect(row(3)).toBeUndefined()
  })

  it("sends nothing for an empty change", async () => {
    await changeConversationTags(1, {})
    expect(api.updateConversationTags).not.toHaveBeenCalled()
  })

  it("never lets a recovery read overwrite a toggle confirmed after it", async () => {
    useAppWorkspaceStore
      .getState()
      .applyConversationUpsert(summary({ id: 1, tag_ids: [5] }))
    let answerRead!: (rows: DbConversationSummary[]) => void
    vi.mocked(api.listAllConversations).mockReturnValueOnce(
      new Promise((resolve) => {
        answerRead = resolve
      })
    )
    vi.mocked(api.updateConversationTags).mockImplementationOnce(async () => {
      useAppWorkspaceStore
        .getState()
        .applyConversationUpsert(summary({ id: 1, tag_ids: [5, 9] }))
      throw new Error("reply lost")
    })
    await expect(changeConversationTags(1, { add: [9] })).rejects.toThrow()
    // Another toggle commits and broadcasts while the recovery read is out…
    useAppWorkspaceStore
      .getState()
      .applyConversationUpsert(summary({ id: 1, tag_ids: [3, 5, 9] }))
    // …and the read, taken before it, answers late.
    answerRead([summary({ id: 1, tag_ids: [5, 9] })])
    await vi.waitFor(() =>
      expect(api.listAllConversations).toHaveBeenCalledWith({
        folder_ids: [1],
      })
    )
    await Promise.resolve()
    expect(row(1)?.tag_ids).toEqual([3, 5, 9])
  })

  it("never resurrects a conversation deleted during a recovery read", async () => {
    useAppWorkspaceStore
      .getState()
      .applyConversationUpsert(summary({ id: 1, tag_ids: [5] }))
    let answerRead!: (rows: DbConversationSummary[]) => void
    vi.mocked(api.listAllConversations).mockReturnValueOnce(
      new Promise((resolve) => {
        answerRead = resolve
      })
    )
    vi.mocked(api.updateConversationTags).mockRejectedValueOnce(
      new Error("refused")
    )
    await expect(changeConversationTags(1, { add: [2] })).rejects.toThrow()
    useAppWorkspaceStore.getState().applyConversationRemove(1)
    answerRead([summary({ id: 1, tag_ids: [5] })])
    await Promise.resolve()
    await Promise.resolve()
    expect(row(1)).toBeUndefined()
  })

  it("repairs a revert that restored another toggle's failed guess", async () => {
    useAppWorkspaceStore.getState().applyConversationUpsert(summary({ id: 1 }))
    // Two toggles in flight; the server accepts neither. The FIRST fails
    // first, while the second's guess (which includes the first's) is shown,
    // so it cannot revert; the second then reverts to what it saw — the
    // first's failed guess.
    let failSecond!: (err: Error) => void
    vi.mocked(api.updateConversationTags)
      .mockRejectedValueOnce(new Error("first refused"))
      .mockReturnValueOnce(
        new Promise((_, reject) => {
          failSecond = reject
        })
      )
    vi.mocked(api.listAllConversations).mockResolvedValue([summary({ id: 1 })])
    const first = changeConversationTags(1, { add: [7] })
    const second = changeConversationTags(1, { add: [8] })
    await expect(first).rejects.toThrow()
    failSecond(new Error("second refused"))
    await expect(second).rejects.toThrow()
    // Without the re-read the row would be left on [7]; the server holds [].
    await vi.waitFor(() => expect(row(1)?.tag_ids ?? []).toEqual([]))
  })
})
