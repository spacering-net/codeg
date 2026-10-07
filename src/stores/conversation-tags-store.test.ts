import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ConversationBranchTag, ConversationTagDetail } from "@/lib/types"

vi.mock("@/lib/api", () => ({
  listConversationTags: vi.fn(async () => []),
  createConversationTag: vi.fn(),
  updateConversationTag: vi.fn(),
  deleteConversationTag: vi.fn(),
  reorderConversationTags: vi.fn(),
  getConversationBranchTag: vi.fn(),
  updateConversationBranchTag: vi.fn(),
}))

const api = await import("@/lib/api")
const { resetConversationTagsStore, useConversationTagsStore } =
  await import("./conversation-tags-store")

function tag(
  id: number,
  overrides: Partial<ConversationTagDetail> = {}
): ConversationTagDetail {
  return {
    id,
    folder_id: null,
    name: `tag-${id}`,
    color: "#cf222e",
    sort_order: id,
    ...overrides,
  }
}

/** A promise the test settles by hand, to land replies out of order. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const ids = () => useConversationTagsStore.getState().tags.map((t) => t.id)

const OFF: ConversationBranchTag = { enabled: false, color: "#6e7781" }
const branch = (
  enabled: boolean,
  color = "#0969da"
): ConversationBranchTag => ({
  enabled,
  color,
})
const branchTag = () => useConversationTagsStore.getState().branchTag

beforeEach(() => {
  resetConversationTagsStore()
  vi.mocked(api.listConversationTags).mockReset()
  vi.mocked(api.listConversationTags).mockResolvedValue([])
  vi.mocked(api.reorderConversationTags).mockReset()
  vi.mocked(api.updateConversationTag).mockReset()
  vi.mocked(api.createConversationTag).mockReset()
  vi.mocked(api.getConversationBranchTag).mockReset()
  vi.mocked(api.getConversationBranchTag).mockResolvedValue(OFF)
  vi.mocked(api.updateConversationBranchTag).mockReset()
})

describe("conversation tags store — applyChange", () => {
  it("upserts in display order and keeps tagsById in step", () => {
    const store = useConversationTagsStore.getState()
    store.applyChange({ kind: "upsert", tag: tag(2, { folder_id: 9 }) })
    store.applyChange({ kind: "upsert", tag: tag(1, { sort_order: 5 }) })
    expect(ids()).toEqual([1, 2])
    expect(useConversationTagsStore.getState().tagsById.get(2)?.folder_id).toBe(
      9
    )
  })

  it("treats an identical upsert (our own echo) as a no-op", () => {
    const store = useConversationTagsStore.getState()
    store.applyChange({ kind: "upsert", tag: tag(1) })
    const before = useConversationTagsStore.getState()
    store.applyChange({ kind: "upsert", tag: tag(1) })
    const after = useConversationTagsStore.getState()
    expect(after.tags).toBe(before.tags)
    expect(after.tagsById).toBe(before.tagsById)
  })

  it("never resurrects a deleted tag from a late upsert", () => {
    const store = useConversationTagsStore.getState()
    store.applyChange({ kind: "upsert", tag: tag(1) })
    store.applyChange({ kind: "deleted", id: 1 })
    // A rename's broadcast that raced the delete and lost.
    store.applyChange({ kind: "upsert", tag: tag(1, { name: "renamed" }) })
    expect(ids()).toEqual([])
  })

  it("answers a reorder nudge with a re-read", async () => {
    vi.mocked(api.listConversationTags).mockResolvedValue([
      tag(2, { sort_order: 1 }),
      tag(1, { sort_order: 2 }),
    ])
    useConversationTagsStore.getState().applyChange({ kind: "reordered" })
    await vi.waitFor(() => expect(ids()).toEqual([2, 1]))
  })
})

describe("conversation tags store — fetchTags", () => {
  it("subtracts a delete that landed while the snapshot was in flight", async () => {
    const reply = deferred<ConversationTagDetail[]>()
    vi.mocked(api.listConversationTags).mockReturnValueOnce(reply.promise)
    const fetching = useConversationTagsStore.getState().fetchTags()
    useConversationTagsStore.getState().applyChange({ kind: "deleted", id: 1 })
    reply.resolve([tag(1), tag(2)])
    await fetching
    expect(ids()).toEqual([2])
    expect(useConversationTagsStore.getState().hydrated).toBe(true)
  })

  it("lets the newest snapshot win when replies arrive out of order", async () => {
    const older = deferred<ConversationTagDetail[]>()
    const newer = deferred<ConversationTagDetail[]>()
    vi.mocked(api.listConversationTags)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise)
    const first = useConversationTagsStore.getState().fetchTags()
    const second = useConversationTagsStore.getState().fetchTags()
    newer.resolve([tag(1), tag(2)])
    await second
    older.resolve([tag(1)])
    await first
    expect(ids()).toEqual([1, 2])
  })

  it("keeps a failed first load from reading as an empty list", async () => {
    vi.mocked(api.listConversationTags).mockRejectedValueOnce(new Error("boom"))
    await useConversationTagsStore.getState().fetchTags()
    const state = useConversationTagsStore.getState()
    expect(state.hydrated).toBe(false)
    expect(state.loadError).toContain("boom")
    vi.mocked(api.listConversationTags).mockResolvedValueOnce([tag(1)])
    await useConversationTagsStore.getState().fetchTags()
    expect(useConversationTagsStore.getState().hydrated).toBe(true)
    expect(useConversationTagsStore.getState().loadError).toBeNull()
  })

  it("keeps an upsert that arrived while the snapshot was in flight", async () => {
    useConversationTagsStore
      .getState()
      .applyChange({ kind: "upsert", tag: tag(1, { name: "Bug" }) })
    const reply = deferred<ConversationTagDetail[]>()
    vi.mocked(api.listConversationTags).mockReturnValueOnce(reply.promise)
    const fetching = useConversationTagsStore.getState().fetchTags()
    // Renamed elsewhere, and a tag created, after the snapshot was read.
    const store = useConversationTagsStore.getState()
    store.applyChange({ kind: "upsert", tag: tag(1, { name: "Fixed" }) })
    store.applyChange({ kind: "upsert", tag: tag(5) })
    reply.resolve([tag(1, { name: "Bug" }), tag(2)])
    await fetching
    const byId = useConversationTagsStore.getState().tagsById
    expect(byId.get(1)?.name).toBe("Fixed")
    expect([...byId.keys()].sort()).toEqual([1, 2, 5])
  })
})

describe("conversation tags store — reorderScope", () => {
  it("moves positions at once and keeps them when the write lands", async () => {
    const store = useConversationTagsStore.getState()
    store.applyChange({ kind: "upsert", tag: tag(1, { sort_order: 1 }) })
    store.applyChange({ kind: "upsert", tag: tag(2, { sort_order: 2 }) })
    vi.mocked(api.reorderConversationTags).mockResolvedValueOnce(undefined)
    await useConversationTagsStore.getState().reorderScope([2, 1])
    expect(ids()).toEqual([2, 1])
    expect(api.reorderConversationTags).toHaveBeenCalledWith([2, 1])
  })

  it("re-reads the list when the write fails, and rethrows", async () => {
    const store = useConversationTagsStore.getState()
    store.applyChange({ kind: "upsert", tag: tag(1, { sort_order: 1 }) })
    store.applyChange({ kind: "upsert", tag: tag(2, { sort_order: 2 }) })
    vi.mocked(api.reorderConversationTags).mockRejectedValueOnce(
      new Error("nope")
    )
    vi.mocked(api.listConversationTags).mockResolvedValue([
      tag(1, { sort_order: 1 }),
      tag(2, { sort_order: 2 }),
    ])
    await expect(
      useConversationTagsStore.getState().reorderScope([2, 1])
    ).rejects.toThrow("nope")
    await vi.waitFor(() => expect(ids()).toEqual([1, 2]))
  })
})

describe("conversation tags store — mutation replies", () => {
  it("does not let a late update reply undo a newer broadcast", async () => {
    const store = useConversationTagsStore.getState()
    store.applyChange({ kind: "upsert", tag: tag(7, { name: "Start" }) })
    const reply = deferred<ConversationTagDetail>()
    vi.mocked(api.updateConversationTag).mockReturnValueOnce(reply.promise)
    const updating = useConversationTagsStore
      .getState()
      .updateTag(7, { name: "First" })
    // Our own broadcast, then another window's later rename, beat our reply.
    store.applyChange({ kind: "upsert", tag: tag(7, { name: "First" }) })
    store.applyChange({ kind: "upsert", tag: tag(7, { name: "Second" }) })
    reply.resolve(tag(7, { name: "First" }))
    await updating
    expect(useConversationTagsStore.getState().tagsById.get(7)?.name).toBe(
      "Second"
    )
  })

  it("applies an update reply when nothing newer arrived", async () => {
    useConversationTagsStore
      .getState()
      .applyChange({ kind: "upsert", tag: tag(7, { name: "Start" }) })
    vi.mocked(api.updateConversationTag).mockResolvedValueOnce(
      tag(7, { name: "First" })
    )
    // What the server holds when the follow-up read lands.
    vi.mocked(api.listConversationTags).mockResolvedValue([
      tag(7, { name: "First" }),
    ])
    await useConversationTagsStore.getState().updateTag(7, { name: "First" })
    expect(useConversationTagsStore.getState().tagsById.get(7)?.name).toBe(
      "First"
    )
  })

  it("only inserts from a create reply, never overwrites", async () => {
    const reply = deferred<ConversationTagDetail>()
    vi.mocked(api.createConversationTag).mockReturnValueOnce(reply.promise)
    const creating = useConversationTagsStore
      .getState()
      .createTag({ folderId: null, name: "New", color: "#cf222e" })
    // The create's broadcast, then a rename from elsewhere, land first.
    const store = useConversationTagsStore.getState()
    store.applyChange({ kind: "upsert", tag: tag(9, { name: "New" }) })
    store.applyChange({ kind: "upsert", tag: tag(9, { name: "Renamed" }) })
    reply.resolve(tag(9, { name: "New" }))
    const created = await creating
    expect(created.name).toBe("Renamed")
    expect(useConversationTagsStore.getState().tagsById.get(9)?.name).toBe(
      "Renamed"
    )
  })

  it("puts a created tag in the store even before its broadcast", async () => {
    vi.mocked(api.createConversationTag).mockResolvedValueOnce(tag(9))
    vi.mocked(api.listConversationTags).mockResolvedValue([tag(9)])
    await useConversationTagsStore
      .getState()
      .createTag({ folderId: null, name: "tag-9", color: "#cf222e" })
    expect(useConversationTagsStore.getState().tagsById.has(9)).toBe(true)
    // …and it survives the reconciling read that follows.
    await vi.waitFor(() =>
      expect(api.listConversationTags).toHaveBeenCalledTimes(1)
    )
    await Promise.resolve()
    expect(useConversationTagsStore.getState().tagsById.has(9)).toBe(true)
  })

  it("reconciles a create reply that beat its broadcast with a later read", async () => {
    // A reconnect read is in flight when the create's reply lands (its
    // broadcast was lost); the tag is then deleted elsewhere unseen.
    const inFlight = deferred<ConversationTagDetail[]>()
    vi.mocked(api.listConversationTags)
      .mockReturnValueOnce(inFlight.promise)
      .mockResolvedValueOnce([])
    const fetching = useConversationTagsStore.getState().fetchTags()
    vi.mocked(api.createConversationTag).mockResolvedValueOnce(tag(9))
    await useConversationTagsStore
      .getState()
      .createTag({ folderId: null, name: "tag-9", color: "#cf222e" })
    inFlight.resolve([])
    await fetching
    // The read requested after the reply is the one that decides.
    await vi.waitFor(() =>
      expect(useConversationTagsStore.getState().tagsById.has(9)).toBe(false)
    )
  })
})

describe("conversation tags store — branch tag", () => {
  it("reads as off until loaded, then holds what was read", async () => {
    expect(branchTag().enabled).toBe(false)
    expect(useConversationTagsStore.getState().branchTagLoaded).toBe(false)
    vi.mocked(api.getConversationBranchTag).mockResolvedValueOnce(branch(true))
    await useConversationTagsStore.getState().fetchBranchTag()
    expect(branchTag()).toEqual(branch(true))
    expect(useConversationTagsStore.getState().branchTagLoaded).toBe(true)
  })

  it("keeps a failed load from reading as known", async () => {
    vi.mocked(api.getConversationBranchTag).mockRejectedValueOnce(
      new Error("boom")
    )
    await useConversationTagsStore.getState().fetchBranchTag()
    const state = useConversationTagsStore.getState()
    expect(state.branchTagLoaded).toBe(false)
    expect(state.branchTagLoadError).toContain("boom")
  })

  it("takes a broadcast as known, and lets it win over a read already out", async () => {
    const reply = deferred<ConversationBranchTag>()
    vi.mocked(api.getConversationBranchTag).mockReturnValueOnce(reply.promise)
    const fetching = useConversationTagsStore.getState().fetchBranchTag()
    useConversationTagsStore
      .getState()
      .applyChange({ kind: "branch_tag", setting: branch(true, "#1a7f37") })
    expect(useConversationTagsStore.getState().branchTagLoaded).toBe(true)
    reply.resolve(OFF)
    await fetching
    expect(branchTag()).toEqual(branch(true, "#1a7f37"))
  })

  it("shows a save at once and settles on the value as stored", async () => {
    const reply = deferred<ConversationBranchTag>()
    vi.mocked(api.updateConversationBranchTag).mockReturnValueOnce(
      reply.promise
    )
    // The reconciling read never answers, so what the save settles on can
    // only have come from its own reply.
    vi.mocked(api.getConversationBranchTag).mockReturnValue(
      new Promise<ConversationBranchTag>(() => {})
    )
    const saving = useConversationTagsStore
      .getState()
      .setBranchTag(branch(true, "#ABCDEF"))
    expect(branchTag()).toEqual(branch(true, "#ABCDEF"))
    expect(api.updateConversationBranchTag).toHaveBeenCalledWith(
      branch(true, "#ABCDEF")
    )
    reply.resolve(branch(true, "#abcdef"))
    await saving
    expect(branchTag()).toEqual(branch(true, "#abcdef"))
    // Its broadcast had not come first, so a read requested after it decides.
    expect(api.getConversationBranchTag).toHaveBeenCalledTimes(1)
  })

  it("does not let a late reply undo a newer broadcast", async () => {
    const reply = deferred<ConversationBranchTag>()
    vi.mocked(api.updateConversationBranchTag).mockReturnValueOnce(
      reply.promise
    )
    const saving = useConversationTagsStore
      .getState()
      .setBranchTag(branch(true))
    // Another window saved after us, and its broadcast beat our reply.
    useConversationTagsStore
      .getState()
      .applyChange({ kind: "branch_tag", setting: branch(false, "#cf222e") })
    reply.resolve(branch(true))
    await saving
    expect(branchTag()).toEqual(branch(false, "#cf222e"))
    expect(api.getConversationBranchTag).not.toHaveBeenCalled()
  })

  it("puts the old value back when a save fails, re-reads, and rethrows", async () => {
    const before = branch(true, "#1a7f37")
    const attempted = branch(false, "#cf222e")
    useConversationTagsStore
      .getState()
      .applyChange({ kind: "branch_tag", setting: before })
    vi.mocked(api.updateConversationBranchTag).mockRejectedValueOnce(
      new Error("offline")
    )
    const reread = deferred<ConversationBranchTag>()
    vi.mocked(api.getConversationBranchTag).mockReturnValueOnce(reread.promise)
    await expect(
      useConversationTagsStore.getState().setBranchTag(attempted)
    ).rejects.toThrow("offline")
    expect(branchTag()).toEqual(before)
    // The write landed after all; only its reply was lost.
    reread.resolve(attempted)
    await vi.waitFor(() => expect(branchTag()).toEqual(attempted))
  })

  it("keeps the restored value known when the re-read fails too", async () => {
    const before = branch(true, "#1a7f37")
    useConversationTagsStore
      .getState()
      .applyChange({ kind: "branch_tag", setting: before })
    vi.mocked(api.updateConversationBranchTag).mockRejectedValueOnce(
      new Error("offline")
    )
    vi.mocked(api.getConversationBranchTag).mockRejectedValueOnce(
      new Error("still offline")
    )
    await expect(
      useConversationTagsStore.getState().setBranchTag(branch(false))
    ).rejects.toThrow("offline")
    await vi.waitFor(() =>
      expect(useConversationTagsStore.getState().branchTagLoadError).toContain(
        "still offline"
      )
    )
    const state = useConversationTagsStore.getState()
    expect(state.branchTag).toEqual(before)
    expect(state.branchTagLoaded).toBe(true)
  })

  it("does not undo a newer broadcast when a save fails", async () => {
    const reply = deferred<ConversationBranchTag>()
    vi.mocked(api.updateConversationBranchTag).mockReturnValueOnce(
      reply.promise
    )
    vi.mocked(api.getConversationBranchTag).mockReturnValue(
      new Promise<ConversationBranchTag>(() => {})
    )
    const saving = useConversationTagsStore
      .getState()
      .setBranchTag(branch(true))
    useConversationTagsStore
      .getState()
      .applyChange({ kind: "branch_tag", setting: branch(true, "#cf222e") })
    reply.reject(new Error("offline"))
    await expect(saving).rejects.toThrow("offline")
    expect(branchTag()).toEqual(branch(true, "#cf222e"))
  })
})
