import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "./app-workspace-store"
import type { DbConversationSummary, FolderDetail } from "@/lib/types"

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
}))

const { getFolder, getGitHead, listAllFolderDetails, listOpenFolderDetails } =
  await import("@/lib/api")
const mockGetFolder = vi.mocked(getFolder)
const mockGetGitHead = vi.mocked(getGitHead)
const mockListAllFolders = vi.mocked(listAllFolderDetails)
const mockListOpenFolders = vi.mocked(listOpenFolderDetails)

function makeSummary(
  overrides: Partial<DbConversationSummary> & { id: number }
): DbConversationSummary {
  return {
    folder_id: 1,
    title: null,
    title_locked: false,
    agent_type: "claude_code",
    status: "in_progress",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 0,
    child_count: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    pinned_at: null,
    parent_id: null,
    parent_tool_use_id: null,
    delegation_call_id: null,
    ...overrides,
  }
}

beforeEach(() => {
  resetAppWorkspaceStore()
})

describe("updateConversationLocal — stats reference stability", () => {
  function seedTwo() {
    const store = useAppWorkspaceStore.getState()
    store.applyConversationUpsert(makeSummary({ id: 1, message_count: 3 }))
    store.applyConversationUpsert(makeSummary({ id: 2, message_count: 4 }))
  }

  it("reuses the stats reference on a status patch (no stat can change)", () => {
    seedTwo()
    const before = useAppWorkspaceStore.getState()
    const statsBefore = before.stats
    const conversationsBefore = before.conversations

    useAppWorkspaceStore
      .getState()
      .updateConversationLocal(1, { status: "pending_review" })

    const after = useAppWorkspaceStore.getState()
    // The regression guard: a turn-boundary status flip must NOT mint a fresh
    // `stats` object (which would re-render every stats subscriber for a no-op).
    expect(after.stats).toBe(statsBefore)
    // But the row's data genuinely changed, so `conversations` gets a new ref
    // (sidebar consumers must see the status update).
    expect(after.conversations).not.toBe(conversationsBefore)
    expect(after.conversations.find((c) => c.id === 1)?.status).toBe(
      "pending_review"
    )
  })

  it("reuses the stats reference on a title patch", () => {
    seedTwo()
    const statsBefore = useAppWorkspaceStore.getState().stats

    useAppWorkspaceStore
      .getState()
      .updateConversationLocal(2, { title: "Renamed" })

    const after = useAppWorkspaceStore.getState()
    expect(after.stats).toBe(statsBefore)
    expect(after.conversations.find((c) => c.id === 2)?.title).toBe("Renamed")
  })

  it("leaves updated_at alone for a pin toggle or a pin reorder", () => {
    seedTwo()
    const { updateConversationLocal } = useAppWorkspaceStore.getState()
    const row = (id: number) =>
      useAppWorkspaceStore.getState().conversations.find((c) => c.id === id)

    // A view preference, not activity: an updated-sorted folder must not float
    // the row (mirrors the backend's update_pin / reorder_pins).
    updateConversationLocal(1, { pinned_at: "2026-02-01T00:00:00.000Z" })
    updateConversationLocal(1, { pin_order: 0 })
    expect(row(1)?.pin_order).toBe(0)
    expect(row(1)?.updated_at).toBe("2026-01-01T00:00:00.000Z")

    // A status patch is activity and still bumps it.
    updateConversationLocal(2, { status: "completed" })
    expect(row(2)?.updated_at).not.toBe("2026-01-01T00:00:00.000Z")
  })

  it("leaves state untouched (stable refs) for an unknown id", () => {
    seedTwo()
    const before = useAppWorkspaceStore.getState()

    before.updateConversationLocal(999, { status: "cancelled" })

    const after = useAppWorkspaceStore.getState()
    expect(after.stats).toBe(before.stats)
    expect(after.conversations).toBe(before.conversations)
  })

  it("still tracks stats when message_count actually changes (via upsert)", () => {
    seedTwo()
    // total_messages = 3 + 4
    expect(useAppWorkspaceStore.getState().stats?.total_messages).toBe(7)

    // A real message_count change flows through applyConversationUpsert (whose
    // recompute we intentionally left intact), so stats update as before.
    useAppWorkspaceStore
      .getState()
      .applyConversationUpsert(makeSummary({ id: 1, message_count: 10 }))

    expect(useAppWorkspaceStore.getState().stats?.total_messages).toBe(14)
  })
})

function makeFolder(
  overrides: Partial<FolderDetail> & { id: number }
): FolderDetail {
  return {
    name: "repo",
    path: "/tmp/repo",
    git_branch: null,
    default_agent_type: null,
    last_opened_at: "2026-01-01T00:00:00.000Z",
    sort_order: 1,
    color: "#000000",
    parent_id: null,
    kind: "regular",
    alias: null,
    group_id: null,
    ...overrides,
  }
}

describe("refreshFolder — branch null-guard", () => {
  it("keeps the poll-resolved branch when the refreshed row's git_branch is null", async () => {
    // Git-head polling has populated the display branch; the folder row's
    // `git_branch` column is null (it always is today), so the refresh must
    // leave the polled name alone.
    useAppWorkspaceStore.getState().setBranch(1, "feature/x")
    mockGetFolder.mockResolvedValue(makeFolder({ id: 1, git_branch: null }))

    await useAppWorkspaceStore.getState().refreshFolder(1)

    // Regression guard for the "no branch" flash: a null DB branch must not
    // clobber the polled name (which would blank the bottom selector until the
    // next poll, up to 10s later).
    expect(useAppWorkspaceStore.getState().branches.get(1)).toBe("feature/x")
  })

  it("adopts the refreshed branch when the row actually carries one", async () => {
    useAppWorkspaceStore.getState().setBranch(1, "old")
    mockGetFolder.mockResolvedValue(makeFolder({ id: 1, git_branch: "main" }))

    await useAppWorkspaceStore.getState().refreshFolder(1)

    expect(useAppWorkspaceStore.getState().branches.get(1)).toBe("main")
  })
})

describe("applyFolderRemove", () => {
  it("drops the folder and its branch/HEAD entries from every list", () => {
    const store = useAppWorkspaceStore.getState()
    store.upsertFolder(makeFolder({ id: 1 }))
    store.upsertFolder(makeFolder({ id: 2, parent_id: 1 }))
    store.setBranch(2, "task/7")
    store.applyGitHead(2, {
      is_repo: true,
      branch: "task/7",
      detached: false,
      short_sha: "abc1234",
    })

    useAppWorkspaceStore.getState().applyFolderRemove(2)

    const after = useAppWorkspaceStore.getState()
    expect(after.folders.map((f) => f.id)).toEqual([1])
    expect(after.allFolders.map((f) => f.id)).toEqual([1])
    // Stale branch/HEAD entries would resurface if the id were ever reused.
    expect(after.branches.has(2)).toBe(false)
    expect(after.gitHeads.has(2)).toBe(false)
  })

  it("writes nothing for an unknown id (stable refs, no re-render)", () => {
    useAppWorkspaceStore.getState().upsertFolder(makeFolder({ id: 1 }))
    const before = useAppWorkspaceStore.getState()

    useAppWorkspaceStore.getState().applyFolderRemove(404)

    const after = useAppWorkspaceStore.getState()
    expect(after.folders).toBe(before.folders)
    expect(after.allFolders).toBe(before.allFolders)
    expect(after.branches).toBe(before.branches)
    expect(after.gitHeads).toBe(before.gitHeads)
  })
})

describe("applyFolderRemove — in-flight fetch resurrection guard", () => {
  it("subtracts a removed folder from a snapshot that was already in flight", async () => {
    // Mount / reconnect `fetchFolders` replaces both lists wholesale. A
    // response captured BEFORE the worktree was deleted would otherwise put it
    // straight back on screen.
    const alive = [makeFolder({ id: 1 }), makeFolder({ id: 2, parent_id: 1 })]
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mockListOpenFolders.mockImplementation(async () => {
      await gate
      return alive
    })
    mockListAllFolders.mockImplementation(async () => {
      await gate
      return alive
    })

    const inFlight = useAppWorkspaceStore.getState().fetchFolders()
    useAppWorkspaceStore.getState().applyFolderRemove(2)
    release()
    await inFlight

    const after = useAppWorkspaceStore.getState()
    expect(after.folders.map((f) => f.id)).toEqual([1])
    expect(after.allFolders.map((f) => f.id)).toEqual([1])
  })

  it("keeps a folder a LATER snapshot still reports (revived while disconnected)", async () => {
    // The reconnect refetch is the reconciliation, and it may be the only place
    // a revive is ever learned: folder ids are reused (a row is revived by path
    // onto the same id), so a task retried after its worktree was cleaned
    // re-creates that exact folder while the socket is down and its upsert
    // event is dropped. Filtering a snapshot requested AFTER the removal would
    // hide that folder forever — and with it every conversation inside it.
    useAppWorkspaceStore.getState().applyFolderRemove(2)

    mockListOpenFolders.mockResolvedValue([makeFolder({ id: 2 })])
    mockListAllFolders.mockResolvedValue([makeFolder({ id: 2 })])
    await useAppWorkspaceStore.getState().fetchFolders()

    expect(useAppWorkspaceStore.getState().folders.map((f) => f.id)).toEqual([
      2,
    ])
    expect(useAppWorkspaceStore.getState().allFolders.map((f) => f.id)).toEqual(
      [2]
    )
  })

  it("lets a later upsert revive the id (a retried task re-creates its worktree)", async () => {
    useAppWorkspaceStore.getState().upsertFolder(makeFolder({ id: 2 }))
    useAppWorkspaceStore.getState().applyFolderRemove(2)
    useAppWorkspaceStore.getState().upsertFolder(makeFolder({ id: 2 }))

    mockListOpenFolders.mockResolvedValue([makeFolder({ id: 2 })])
    mockListAllFolders.mockResolvedValue([makeFolder({ id: 2 })])
    await useAppWorkspaceStore.getState().fetchFolders()

    expect(useAppWorkspaceStore.getState().folders.map((f) => f.id)).toEqual([
      2,
    ])
  })

  it("still filters an in-flight snapshot when a LATER removal is pending", async () => {
    // Two removals, one before the fetch and one during it: only the second may
    // be subtracted, and the first must not smuggle its id back in.
    useAppWorkspaceStore.getState().applyFolderRemove(3)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const snapshot = [makeFolder({ id: 1 }), makeFolder({ id: 2 })]
    mockListOpenFolders.mockImplementation(async () => {
      await gate
      return snapshot
    })
    mockListAllFolders.mockImplementation(async () => {
      await gate
      return snapshot
    })

    const inFlight = useAppWorkspaceStore.getState().fetchFolders()
    useAppWorkspaceStore.getState().applyFolderRemove(2)
    release()
    await inFlight

    expect(useAppWorkspaceStore.getState().folders.map((f) => f.id)).toEqual([
      1,
    ])
  })
})

const {
  applySidebarLayout,
  createFolderGroup,
  deleteFolderGroup,
  listFolderGroups,
  setFolderGroup,
  updateFolderGroup,
} = await import("@/lib/api")

describe("folder groups — in-flight fetch ordering", () => {
  const mockListGroups = vi.mocked(listFolderGroups)
  const mockDeleteGroup = vi.mocked(deleteFolderGroup)

  beforeEach(() => {
    resetAppWorkspaceStore()
    mockListOpenFolders.mockReset().mockResolvedValue([])
    mockListAllFolders.mockReset().mockResolvedValue([])
    mockListGroups.mockReset().mockResolvedValue([])
    mockDeleteGroup.mockReset().mockResolvedValue(undefined)
  })

  it("subtracts a deleted group from a snapshot that was already in flight", async () => {
    // `fetchFolders` replaces `folderGroups` wholesale, so a response captured
    // BEFORE the delete would put the band straight back on screen — and
    // nothing would take it down again: the `deleted` broadcast has already
    // been applied and no-ops the second time.
    const group = { id: 7, name: "Work", color: "inherit", sort_order: 1 }
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mockListGroups.mockImplementation(async () => {
      await gate
      return [group]
    })
    useAppWorkspaceStore.setState({ folderGroups: [group] })

    const inFlight = useAppWorkspaceStore.getState().fetchFolders()
    await useAppWorkspaceStore.getState().deleteFolderGroup(7)
    release()
    await inFlight

    expect(useAppWorkspaceStore.getState().folderGroups).toEqual([])
  })

  it("keeps a group a LATER snapshot still reports", async () => {
    // The mirror of the guard above: filtering a snapshot requested AFTER the
    // delete would hide a group that was re-created since, and the reconnect
    // refetch may be the only place that re-creation is ever learned.
    await useAppWorkspaceStore.getState().deleteFolderGroup(7)

    const revived = { id: 7, name: "Work", color: "inherit", sort_order: 1 }
    mockListGroups.mockResolvedValue([revived])
    await useAppWorkspaceStore.getState().fetchFolders()

    expect(useAppWorkspaceStore.getState().folderGroups).toEqual([revived])
  })

  it("discards a snapshot older than one already applied", async () => {
    // Every drag ends in a `layout` nudge that triggers a refetch, so two
    // fetches are routinely in flight. If the earlier one resolves last, the
    // sidebar would settle on the second-to-last order with nothing left to
    // correct it.
    const older = [{ id: 1, name: "Old", color: "inherit", sort_order: 1 }]
    const newer = [{ id: 2, name: "New", color: "inherit", sort_order: 1 }]
    let releaseFirst: () => void = () => {}
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    mockListGroups
      .mockImplementationOnce(async () => {
        await firstGate
        return older
      })
      .mockImplementationOnce(async () => newer)

    const first = useAppWorkspaceStore.getState().fetchFolders()
    await useAppWorkspaceStore.getState().fetchFolders()
    expect(useAppWorkspaceStore.getState().folderGroups).toEqual(newer)

    releaseFirst()
    await first
    expect(useAppWorkspaceStore.getState().folderGroups).toEqual(newer)
  })
})

describe("folder groups", () => {
  const mockApplyLayout = vi.mocked(applySidebarLayout)
  const mockCreateGroup = vi.mocked(createFolderGroup)
  const mockDeleteGroup = vi.mocked(deleteFolderGroup)
  const mockSetGroup = vi.mocked(setFolderGroup)
  const mockUpdateGroup = vi.mocked(updateFolderGroup)
  const mockListGroups = vi.mocked(listFolderGroups)

  /** Let the resync a failed mutation kicks off settle before asserting. */
  const flushResync = () => new Promise((resolve) => setTimeout(resolve, 0))

  beforeEach(() => {
    resetAppWorkspaceStore()
    mockListOpenFolders.mockReset().mockResolvedValue([])
    mockListAllFolders.mockReset().mockResolvedValue([])
    mockListGroups.mockReset().mockResolvedValue([])
    mockApplyLayout.mockReset().mockResolvedValue(undefined)
    mockCreateGroup.mockReset()
    mockDeleteGroup.mockReset().mockResolvedValue(undefined)
    mockSetGroup.mockReset().mockResolvedValue(undefined)
    mockUpdateGroup.mockReset().mockResolvedValue({
      id: 7,
      name: "Work",
      color: "inherit",
      sort_order: 1,
    })
  })

  it("mirrors the backend's per-container counter when applying a layout", async () => {
    const folders = [
      makeFolder({ id: 1, sort_order: 9 }),
      makeFolder({ id: 5, sort_order: 9 }),
      makeFolder({ id: 6, sort_order: 9 }),
    ]
    useAppWorkspaceStore.setState({
      folders,
      allFolders: folders,
      folderGroups: [{ id: 7, name: "Work", color: "inherit", sort_order: 9 }],
    })

    await useAppWorkspaceStore.getState().applySidebarLayout([
      { kind: "folder", id: 1, groupId: null },
      { kind: "group", id: 7, groupId: null },
      { kind: "folder", id: 5, groupId: 7 },
      { kind: "folder", id: 6, groupId: 7 },
    ])

    const byId = new Map(
      useAppWorkspaceStore.getState().folders.map((f) => [f.id, f])
    )
    // Top level: folder 1 then group 7 — one shared 1-based sequence.
    expect(byId.get(1)).toMatchObject({ sort_order: 1, group_id: null })
    expect(useAppWorkspaceStore.getState().folderGroups[0].sort_order).toBe(2)
    // Inside the group: its own 1..n.
    expect(byId.get(5)).toMatchObject({ sort_order: 1, group_id: 7 })
    expect(byId.get(6)).toMatchObject({ sort_order: 2, group_id: 7 })
  })

  it("rolls the optimistic layout back when the write fails, then resyncs", async () => {
    const folders = [makeFolder({ id: 1, sort_order: 3, group_id: null })]
    useAppWorkspaceStore.setState({ folders, allFolders: folders })
    mockApplyLayout.mockRejectedValue(new Error("boom"))
    // Nothing was written, so the server still holds the pre-drag order.
    mockListOpenFolders.mockResolvedValue(folders)
    mockListAllFolders.mockResolvedValue(folders)

    await expect(
      useAppWorkspaceStore
        .getState()
        .applySidebarLayout([{ kind: "folder", id: 1, groupId: 7 }])
    ).rejects.toThrow("boom")

    // Restored straight away, so the sidebar snaps back without waiting on a
    // round trip...
    expect(useAppWorkspaceStore.getState().folders[0]).toMatchObject({
      sort_order: 3,
      group_id: null,
    })
    // ...and the resync then confirms it against the server, which is what
    // stops the restore from erasing anything that landed mid-request.
    await flushResync()
    expect(mockListOpenFolders).toHaveBeenCalled()
    expect(useAppWorkspaceStore.getState().folders[0]).toMatchObject({
      sort_order: 3,
      group_id: null,
    })
  })

  it("inserts a created group immediately so a follow-up move can land in it", async () => {
    mockCreateGroup.mockResolvedValue({
      id: 7,
      name: "Work",
      color: "inherit",
      sort_order: 1,
    })
    await useAppWorkspaceStore.getState().createFolderGroup("Work")
    expect(useAppWorkspaceStore.getState().folderGroups).toEqual([
      { id: 7, name: "Work", color: "inherit", sort_order: 1 },
    ])
  })

  it("keeps a deleted group's folders, returning them to the top level", async () => {
    const folders = [
      makeFolder({ id: 5, group_id: 7 }),
      makeFolder({ id: 6, group_id: 7 }),
    ]
    useAppWorkspaceStore.setState({
      folders,
      allFolders: folders,
      folderGroups: [{ id: 7, name: "Work", color: "inherit", sort_order: 1 }],
    })

    await useAppWorkspaceStore.getState().deleteFolderGroup(7)

    expect(useAppWorkspaceStore.getState().folderGroups).toEqual([])
    // The folders must survive — "delete group" is not "close these folders".
    expect(useAppWorkspaceStore.getState().folders.map((f) => f.id)).toEqual([
      5, 6,
    ])
    expect(
      useAppWorkspaceStore.getState().folders.every((f) => f.group_id === null)
    ).toBe(true)
  })

  it("restores the group and its members when the delete fails", async () => {
    const folders = [makeFolder({ id: 5, group_id: 7 })]
    const group = { id: 7, name: "Work", color: "inherit", sort_order: 1 }
    useAppWorkspaceStore.setState({
      folders,
      allFolders: folders,
      folderGroups: [group],
    })
    mockDeleteGroup.mockRejectedValue(new Error("nope"))
    // The delete failed, so the server still has the group and its member.
    mockListOpenFolders.mockResolvedValue(folders)
    mockListAllFolders.mockResolvedValue(folders)
    mockListGroups.mockResolvedValue([group])

    await expect(
      useAppWorkspaceStore.getState().deleteFolderGroup(7)
    ).rejects.toThrow("nope")

    expect(useAppWorkspaceStore.getState().folderGroups).toHaveLength(1)
    expect(useAppWorkspaceStore.getState().folders[0].group_id).toBe(7)
    // The failed delete must also drop its tombstone, or the resync it kicks
    // off would filter the group right back out of the snapshot.
    await flushResync()
    expect(useAppWorkspaceStore.getState().folderGroups).toEqual([group])
  })

  it("moves one folder into and back out of a group", async () => {
    const folders = [makeFolder({ id: 5 })]
    useAppWorkspaceStore.setState({ folders, allFolders: folders })

    await useAppWorkspaceStore.getState().setFolderGroup(5, 7)
    expect(useAppWorkspaceStore.getState().folders[0].group_id).toBe(7)
    expect(mockSetGroup).toHaveBeenCalledWith(5, 7)

    await useAppWorkspaceStore.getState().setFolderGroup(5, null)
    expect(useAppWorkspaceStore.getState().folders[0].group_id).toBeNull()
  })

  it("patches only the named fields on update", async () => {
    useAppWorkspaceStore.setState({
      folderGroups: [{ id: 7, name: "Work", color: "red", sort_order: 1 }],
    })
    await useAppWorkspaceStore.getState().updateFolderGroup(7, { name: "Day" })
    // A rename must not reset the color the picker set.
    expect(useAppWorkspaceStore.getState().folderGroups[0]).toMatchObject({
      name: "Day",
      color: "red",
    })
  })

  it("applies upsert / deleted broadcasts without a refetch", () => {
    const folders = [makeFolder({ id: 5, group_id: 7 })]
    useAppWorkspaceStore.setState({
      folders,
      allFolders: folders,
      folderGroups: [{ id: 7, name: "Work", color: "inherit", sort_order: 1 }],
    })

    useAppWorkspaceStore.getState().applyFolderGroupChange({
      kind: "upsert",
      group: { id: 7, name: "Renamed", color: "blue", sort_order: 1 },
    })
    expect(useAppWorkspaceStore.getState().folderGroups[0]).toMatchObject({
      name: "Renamed",
      color: "blue",
    })

    useAppWorkspaceStore
      .getState()
      .applyFolderGroupChange({ kind: "deleted", id: 7 })
    expect(useAppWorkspaceStore.getState().folderGroups).toEqual([])
    // A peer's delete releases the members here too, so they don't render as
    // belonging to a group that no longer exists.
    expect(useAppWorkspaceStore.getState().folders[0].group_id).toBeNull()
  })

  it("answers a layout broadcast with a re-read", async () => {
    mockListOpenFolders.mockResolvedValue([makeFolder({ id: 5, group_id: 7 })])
    mockListAllFolders.mockResolvedValue([makeFolder({ id: 5, group_id: 7 })])

    useAppWorkspaceStore.getState().applyFolderGroupChange({ kind: "layout" })
    await vi.waitFor(() => {
      expect(useAppWorkspaceStore.getState().folders).toHaveLength(1)
    })
    expect(useAppWorkspaceStore.getState().folders[0].group_id).toBe(7)
  })
})

describe("ensureGitHead — HEAD for a folder the poll doesn't cover", () => {
  // The workspace polls exactly ONE folder (the active tab's), and the folder
  // row's `git_branch` column is never written — so any surface showing several
  // folders at once (a canvas board of conversation cards) had no way to learn
  // its folders' branches and rendered every chip as "no branch".
  beforeEach(() => {
    mockGetGitHead.mockReset()
  })

  it("resolves an unknown folder's HEAD into branches and gitHeads", async () => {
    mockGetGitHead.mockResolvedValue({
      is_repo: true,
      branch: "feature/x",
      detached: false,
      short_sha: "abc1234",
    })

    useAppWorkspaceStore.getState().ensureGitHead(9, "/tmp/repo")

    await vi.waitFor(() => {
      expect(useAppWorkspaceStore.getState().gitHeads.get(9)?.branch).toBe(
        "feature/x"
      )
    })
    // Both maps, because the chip reads `branches` for the label and `gitHeads`
    // for "is this a repo at all".
    expect(useAppWorkspaceStore.getState().branches.get(9)).toBe("feature/x")
    expect(mockGetGitHead).toHaveBeenCalledWith("/tmp/repo")
  })

  it("does not re-ask for a folder whose HEAD is already known", () => {
    useAppWorkspaceStore.getState().applyGitHead(9, {
      is_repo: true,
      branch: "main",
      detached: false,
      short_sha: "abc1234",
    })

    useAppWorkspaceStore.getState().ensureGitHead(9, "/tmp/repo")

    expect(mockGetGitHead).not.toHaveBeenCalled()
  })

  it("asks once when every card on a board asks at the same time", async () => {
    // A board mounts one branch chip per card. Without in-flight dedup, twenty
    // cards over one folder would be twenty `git rev-parse` round trips in a
    // single frame — and `gitHeads` cannot answer for them, because none of them
    // has resolved yet.
    let resolveHead: (value: {
      is_repo: boolean
      branch: string | null
      detached: boolean
      short_sha: string | null
    }) => void = () => {}
    mockGetGitHead.mockReturnValue(
      new Promise((resolve) => {
        resolveHead = resolve
      })
    )

    const { ensureGitHead } = useAppWorkspaceStore.getState()
    ensureGitHead(9, "/tmp/repo")
    ensureGitHead(9, "/tmp/repo")
    ensureGitHead(9, "/tmp/repo")

    expect(mockGetGitHead).toHaveBeenCalledTimes(1)

    resolveHead({
      is_repo: true,
      branch: "main",
      detached: false,
      short_sha: "abc1234",
    })
    await vi.waitFor(() => {
      expect(useAppWorkspaceStore.getState().gitHeads.has(9)).toBe(true)
    })
  })

  it("lets a failed read be retried instead of pinning the folder to 'no branch'", async () => {
    mockGetGitHead.mockRejectedValueOnce(new Error("boom"))
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})

    useAppWorkspaceStore.getState().ensureGitHead(9, "/tmp/repo")
    await vi.waitFor(() => {
      expect(errors).toHaveBeenCalled()
    })
    expect(useAppWorkspaceStore.getState().gitHeads.has(9)).toBe(false)

    // The in-flight slot has to be released on failure too — otherwise a folder
    // that was mid-clone (or briefly unreachable) reads "no branch" for the rest
    // of the session, with nothing left to ask again.
    mockGetGitHead.mockResolvedValue({
      is_repo: true,
      branch: "main",
      detached: false,
      short_sha: "abc1234",
    })
    useAppWorkspaceStore.getState().ensureGitHead(9, "/tmp/repo")
    await vi.waitFor(() => {
      expect(useAppWorkspaceStore.getState().gitHeads.get(9)?.branch).toBe(
        "main"
      )
    })
    errors.mockRestore()
  })

  it("does not revive the HEAD of a folder removed while the read was in flight", async () => {
    let resolveHead: (value: {
      is_repo: boolean
      branch: string | null
      detached: boolean
      short_sha: string | null
    }) => void = () => {}
    mockGetGitHead.mockReturnValue(
      new Promise((resolve) => {
        resolveHead = resolve
      })
    )
    useAppWorkspaceStore.setState({ allFolders: [makeFolder({ id: 9 })] })

    useAppWorkspaceStore.getState().ensureGitHead(9, "/tmp/repo")
    useAppWorkspaceStore.getState().applyFolderRemove(9)
    resolveHead({
      is_repo: true,
      branch: "main",
      detached: false,
      short_sha: "abc1234",
    })

    await vi.waitFor(() => {
      expect(mockGetGitHead).toHaveBeenCalled()
    })
    expect(useAppWorkspaceStore.getState().gitHeads.has(9)).toBe(false)
  })

  it("re-reads for a folder id that was removed and revived mid-flight", async () => {
    // A retried task re-creates its worktree and `upsertFolder` revives the very
    // same row id — which also forgets the removal tombstone. So "was this id
    // removed since my request started?" cannot be the guard: by the time the
    // old read lands, the tombstone is gone and its answer describes a directory
    // that no longer exists.
    const settle: Array<
      (value: {
        is_repo: boolean
        branch: string | null
        detached: boolean
        short_sha: string | null
      }) => void
    > = []
    mockGetGitHead.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle.push(resolve)
        })
    )
    useAppWorkspaceStore.setState({ allFolders: [makeFolder({ id: 9 })] })

    useAppWorkspaceStore.getState().ensureGitHead(9, "/tmp/repo")
    useAppWorkspaceStore.getState().applyFolderRemove(9)
    useAppWorkspaceStore.getState().upsertFolder(makeFolder({ id: 9 }))

    // The revived folder's chip must not be silenced by the dead read's slot.
    useAppWorkspaceStore.getState().ensureGitHead(9, "/tmp/repo")
    expect(mockGetGitHead).toHaveBeenCalledTimes(2)

    // Old read lands last and must lose: it is the departed worktree's branch.
    settle[1]({
      is_repo: true,
      branch: "task/new",
      detached: false,
      short_sha: "bbb2222",
    })
    settle[0]({
      is_repo: true,
      branch: "task/gone",
      detached: false,
      short_sha: "aaa1111",
    })

    await vi.waitFor(() => {
      expect(useAppWorkspaceStore.getState().gitHeads.get(9)?.branch).toBe(
        "task/new"
      )
    })
    // A moment for the stale resolution to have had its chance to overwrite.
    await Promise.resolve()
    expect(useAppWorkspaceStore.getState().gitHeads.get(9)?.branch).toBe(
      "task/new"
    )
  })
})
