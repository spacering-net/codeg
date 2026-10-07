import { useEffect } from "react"
import { create } from "zustand"
import {
  createConversationTag as apiCreateTag,
  deleteConversationTag as apiDeleteTag,
  getConversationBranchTag,
  listConversationTags,
  reorderConversationTags as apiReorderTags,
  updateConversationBranchTag as apiUpdateBranchTag,
  updateConversationTag as apiUpdateTag,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { DEFAULT_BRANCH_TAG_COLOR, compareTags } from "@/lib/conversation-tags"
import { onTransportReconnect, subscribe } from "@/lib/platform"
import {
  CONVERSATION_TAG_CHANGED_EVENT,
  type ConversationBranchTag,
  type ConversationTagChange,
  type ConversationTagDetail,
} from "@/lib/types"
import { registerBackendScopedStoreReset } from "@/stores/backend-scoped-store-reset"

/**
 * Conversation tag DEFINITIONS (name, colour, scope, order) for this window,
 * and the branch tag setting drawn alongside them.
 *
 * Which tags a conversation carries is NOT here: that is the summary's
 * `tag_ids` in `useAppWorkspaceStore`, so it rides the conversation channel's
 * ordering, tombstones and reconnect refetch. Definitions travel on a channel
 * of their own (`conversation-tag://changed`), so they keep a store of their
 * own too.
 */
export interface ConversationTagsState {
  /** Every tag, in {@link compareTags} order. */
  tags: ConversationTagDetail[]
  /** Same tags keyed by id; a new Map only when `tags` changes. */
  tagsById: ReadonlyMap<number, ConversationTagDetail>
  /** True once a fetch has succeeded: the list is KNOWN, so an id missing
   *  from it really is a deleted tag. A failed load leaves it false. */
  hydrated: boolean
  /** The last fetch's failure, cleared by the next success. */
  loadError: string | null
  /** The branch tag setting. Reads as off until loaded, so nothing is drawn
   *  on the strength of a setting this window does not know yet. */
  branchTag: ConversationBranchTag
  /** True once the setting is known — read, or received in a broadcast. */
  branchTagLoaded: boolean
  /** The last read's failure, cleared by the next success. */
  branchTagLoadError: string | null

  fetchTags: () => Promise<void>
  fetchBranchTag: () => Promise<void>
  /** Save the branch tag setting whole. Optimistic: it shows at once, and is
   *  put back if the write fails (the error is rethrown for the caller). */
  setBranchTag: (setting: ConversationBranchTag) => Promise<void>
  applyChange: (change: ConversationTagChange) => void
  createTag: (args: {
    folderId: number | null
    name: string
    color: string
  }) => Promise<ConversationTagDetail>
  updateTag: (
    tagId: number,
    patch: { name?: string; color?: string }
  ) => Promise<ConversationTagDetail>
  deleteTag: (tagId: number) => Promise<void>
  /** Persist one scope's new order (its complete id list, first to last).
   *  Optimistic: positions change at once and are re-read on failure. */
  reorderScope: (orderedIds: readonly number[]) => Promise<void>
}

function withTags(tags: ConversationTagDetail[]) {
  const sorted = [...tags].sort(compareTags)
  return {
    tags: sorted,
    tagsById: new Map(sorted.map((t) => [t.id, t])) as ReadonlyMap<
      number,
      ConversationTagDetail
    >,
  }
}

// Every applied change is stamped with a mutation sequence number, so a reply
// that was requested BEFORE a change can tell it arrived after it.
//
// - `deletedTagSeq`: deleted ids. Ids come from an AUTOINCREMENT column and are
//   never reused, so an upsert or snapshot naming one later can only be a
//   resurrection (a rename's broadcast racing the delete's, say).
// - `upsertedTagSeq`: the last upsert applied per id, from a broadcast or a
//   reply. A snapshot requested before it is older than what is on screen for
//   that tag, and must not put the older version back.
//
// Both are bounded FIFOs. Evicting an entry only matters for a reply that has
// been out for more than 512 changes, and the next broadcast or refetch still
// converges it.
const SEQ_CAP = 512
const deletedTagSeq = new Map<number, number>()
const upsertedTagSeq = new Map<number, number>()
let mutationSeq = 0
let fetchSeq = 0
let lastAppliedFetch = 0

// The branch tag is one value, so one counter does what the two maps do for
// tags: it moves on every value applied here — a broadcast, an optimistic
// write, a write's reply — and a read or a reply requested before it moved is
// older than what is on screen.
const DEFAULT_BRANCH_TAG: ConversationBranchTag = {
  enabled: false,
  color: DEFAULT_BRANCH_TAG_COLOR,
}
let branchTagSeq = 0
let branchFetchSeq = 0
let lastAppliedBranchFetch = 0

function sameBranchTag(
  a: ConversationBranchTag,
  b: ConversationBranchTag
): boolean {
  return a.enabled === b.enabled && a.color === b.color
}

function stamp(map: Map<number, number>, tagId: number): void {
  mutationSeq += 1
  // Re-insert so the FIFO order follows the latest stamp.
  map.delete(tagId)
  map.set(tagId, mutationSeq)
  if (map.size > SEQ_CAP) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
}

/** Apply one tag as the newest known version of it (a broadcast, or a reply
 *  nothing newer has overtaken). Returns the next `tags` array, or null when
 *  nothing changed. */
function upsertInto(
  tags: ConversationTagDetail[],
  tag: ConversationTagDetail
): ConversationTagDetail[] | null {
  const idx = tags.findIndex((t) => t.id === tag.id)
  if (idx < 0) return [...tags, tag]
  const current = tags[idx]
  if (
    current.name === tag.name &&
    current.color === tag.color &&
    current.sort_order === tag.sort_order &&
    current.folder_id === tag.folder_id
  ) {
    // Our own echo of a write already applied: no new arrays, so no chip
    // anywhere re-renders for it.
    return null
  }
  const next = [...tags]
  next[idx] = tag
  return next
}

export const useConversationTagsStore = create<ConversationTagsState>()(
  (set, get) => ({
    tags: [],
    tagsById: new Map(),
    hydrated: false,
    loadError: null,
    branchTag: DEFAULT_BRANCH_TAG,
    branchTagLoaded: false,
    branchTagLoadError: null,

    fetchTags: async () => {
      const seqAtRequest = mutationSeq
      const id = ++fetchSeq
      try {
        const list = await listConversationTags()
        // Newest request wins: an older snapshot is a strictly earlier view
        // of the same list, never extra information.
        if (id < lastAppliedFetch) return
        lastAppliedFetch = id
        // Merge rather than replace. The snapshot was read at some point after
        // `seqAtRequest`; anything applied here since then may be newer than
        // it, and replacing wholesale would quietly roll that back with no
        // later event to repair it.
        const current = get().tagsById
        const merged = new Map<number, ConversationTagDetail>()
        for (const tag of list) {
          const deletedAt = deletedTagSeq.get(tag.id)
          if (deletedAt !== undefined && deletedAt > seqAtRequest) continue
          const upsertedAt = upsertedTagSeq.get(tag.id)
          const local = current.get(tag.id)
          merged.set(
            tag.id,
            upsertedAt !== undefined && upsertedAt > seqAtRequest && local
              ? local
              : tag
          )
        }
        // Created (or first seen) while the request was out, so not in it.
        for (const [tagId, upsertedAt] of upsertedTagSeq) {
          if (upsertedAt <= seqAtRequest || merged.has(tagId)) continue
          const local = current.get(tagId)
          if (local && !deletedTagSeq.has(tagId)) merged.set(tagId, local)
        }
        set({
          ...withTags([...merged.values()]),
          loadError: null,
          hydrated: true,
        })
      } catch (err) {
        console.error("[ConversationTags] fetch failed:", err)
        // `hydrated` stays as it was: it means "the list is known". A failed
        // first load must not read as "there are no tags" — the sidebar would
        // prune a persisted filter down to nothing on the strength of it.
        set({ loadError: toErrorMessage(err) })
      }
    },

    fetchBranchTag: async () => {
      const seqAtRequest = branchTagSeq
      const id = ++branchFetchSeq
      try {
        const setting = await getConversationBranchTag()
        if (id < lastAppliedBranchFetch) return
        lastAppliedBranchFetch = id
        const next: Partial<ConversationTagsState> = {
          branchTagLoaded: true,
          branchTagLoadError: null,
        }
        // A value applied while the read was out is newer than it.
        if (
          branchTagSeq === seqAtRequest &&
          !sameBranchTag(get().branchTag, setting)
        ) {
          next.branchTag = setting
        }
        set(next)
      } catch (err) {
        console.error("[ConversationTags] branch tag fetch failed:", err)
        set({ branchTagLoadError: toErrorMessage(err) })
      }
    },

    setBranchTag: async (setting) => {
      const previous = get().branchTag
      branchTagSeq += 1
      const seqOfWrite = branchTagSeq
      set({ branchTag: setting })
      try {
        const saved = await apiUpdateBranchTag(setting)
        // Only if nothing arrived while the write was out — its own broadcast
        // usually has, carrying this very value.
        if (branchTagSeq === seqOfWrite) {
          branchTagSeq += 1
          if (!sameBranchTag(get().branchTag, saved)) set({ branchTag: saved })
          // Reconciled with a read requested after it, for the same reason
          // as a tag's create or update reply.
          void get().fetchBranchTag()
        }
      } catch (err) {
        // Put the old value back unless something newer replaced ours in the
        // meantime, then re-read: the write may have landed before its reply
        // was lost.
        if (branchTagSeq === seqOfWrite) {
          branchTagSeq += 1
          set({ branchTag: previous })
        }
        void get().fetchBranchTag()
        throw err
      }
    },

    applyChange: (change) => {
      if (change.kind === "branch_tag") {
        branchTagSeq += 1
        const { branchTag, branchTagLoaded } = get()
        if (branchTagLoaded && sameBranchTag(branchTag, change.setting)) return
        set({
          branchTag: change.setting,
          branchTagLoaded: true,
          branchTagLoadError: null,
        })
        return
      }
      if (change.kind === "upsert") {
        // Never resurrect: see `deletedTagSeq`.
        if (deletedTagSeq.has(change.tag.id)) return
        stamp(upsertedTagSeq, change.tag.id)
        const next = upsertInto(get().tags, change.tag)
        if (next) set(withTags(next))
        return
      }
      if (change.kind === "deleted") {
        stamp(deletedTagSeq, change.id)
        upsertedTagSeq.delete(change.id)
        const { tags } = get()
        if (!tags.some((t) => t.id === change.id)) return
        set(withTags(tags.filter((t) => t.id !== change.id)))
        return
      }
      // `reordered` carries no payload by design: re-read the list.
      void get().fetchTags()
    },

    createTag: async (args) => {
      const tag = await apiCreateTag(args)
      // The create's own broadcast usually lands first, and anything for this
      // id that has arrived since — a rename from another window — is newer
      // than this reply. So the reply only ever INSERTS: callers need the tag
      // in the store right away (to draw it on the conversation they are
      // tagging) even when the broadcast is slow or the socket is down.
      if (!get().tagsById.has(tag.id) && !deletedTagSeq.has(tag.id)) {
        get().applyChange({ kind: "upsert", tag })
        // A reply is not ordered against other windows' writes the way a
        // broadcast is, so what it put here is reconciled with a list read
        // requested AFTER it — otherwise a snapshot already in flight would
        // see it as "newer than me" and keep it even if the tag has since
        // been deleted elsewhere. Only on this path: when the broadcast came
        // first (the usual case) there is nothing to reconcile.
        void get().fetchTags()
      }
      return get().tagsById.get(tag.id) ?? tag
    },

    updateTag: async (tagId, patch) => {
      const seqAtRequest = mutationSeq
      const tag = await apiUpdateTag(tagId, patch)
      // Applied only if nothing for this tag arrived while the request was
      // out. If something did, it is either our own broadcast (already
      // applied) or a later write from elsewhere, which this reply must not
      // overwrite.
      const upsertedAt = upsertedTagSeq.get(tagId)
      if (upsertedAt === undefined || upsertedAt <= seqAtRequest) {
        get().applyChange({ kind: "upsert", tag })
        // Reconciled the same way, and for the same reason, as a create reply.
        void get().fetchTags()
      }
      return tag
    },

    deleteTag: async (tagId) => {
      await apiDeleteTag(tagId)
      get().applyChange({ kind: "deleted", id: tagId })
    },

    reorderScope: async (orderedIds) => {
      const position = new Map(orderedIds.map((id, idx) => [id, idx + 1]))
      const { tags } = get()
      set(
        withTags(
          tags.map((t) =>
            position.has(t.id) ? { ...t, sort_order: position.get(t.id)! } : t
          )
        )
      )
      try {
        await apiReorderTags([...orderedIds])
      } catch (err) {
        // Re-read rather than restore a snapshot: anything that landed while
        // the request was out would be erased along with our failed write.
        void get().fetchTags()
        throw err
      }
    },
  })
)

/** Restore the pristine state, tombstones included. Tests and the
 *  backend-scoped reset registry only. */
export function resetConversationTagsStore(): void {
  deletedTagSeq.clear()
  upsertedTagSeq.clear()
  mutationSeq = 0
  fetchSeq = 0
  lastAppliedFetch = 0
  branchTagSeq = 0
  branchFetchSeq = 0
  lastAppliedBranchFetch = 0
  useConversationTagsStore.setState(
    useConversationTagsStore.getInitialState(),
    true
  )
}

registerBackendScopedStoreReset(resetConversationTagsStore)

/**
 * Keep this window's tag definitions and branch tag setting live: one fetch
 * of each on mount, every `conversation-tag://changed` broadcast applied in
 * place, and a re-read after a WebSocket reconnect (the broadcaster drops what
 * fires while nobody is listening). Mount once per window — the workspace
 * layout does.
 */
export function useConversationTagsSync(): void {
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    const store = useConversationTagsStore.getState()
    void store.fetchTags()
    void store.fetchBranchTag()

    void (async () => {
      const dispose = await subscribe<ConversationTagChange>(
        CONVERSATION_TAG_CHANGED_EVENT,
        (change) => {
          useConversationTagsStore.getState().applyChange(change)
        }
      )
      if (disposed) dispose()
      else unlisten = dispose
    })()

    const offReconnect = onTransportReconnect(() => {
      const current = useConversationTagsStore.getState()
      void current.fetchTags()
      void current.fetchBranchTag()
    })

    return () => {
      disposed = true
      unlisten?.()
      offReconnect?.()
    }
  }, [])
}

/** The bridge component for layouts: mounts {@link useConversationTagsSync}. */
export function ConversationTagsSync(): null {
  useConversationTagsSync()
  return null
}
