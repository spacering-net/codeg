import { useEffect, useMemo } from "react"
import { create } from "zustand"
import {
  assistantCreate,
  assistantDelete,
  assistantList,
  assistantReorder,
  assistantUpdate,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { onTransportReconnect, subscribe } from "@/lib/platform"
import {
  ASSISTANT_CHANGED_EVENT,
  type AssistantChange,
  type AssistantDraft,
  type AssistantInfo,
  type AssistantPatch,
} from "@/lib/types"
import { registerBackendScopedStoreReset } from "@/stores/backend-scoped-store-reset"

/**
 * The assistants this window knows — tombstones included, so delegation cards
 * and mention badges can still draw an assistant that was deleted.
 *
 * One merge rule covers every source (the list read, a write's reply, a
 * broadcast): per id, keep whichever copy carries the higher `revision`. The
 * backend bumps `revision` in SQL on every write and only ever sends whole
 * rows, so one revision names one content — which makes the rule safe against
 * late replies, out-of-order broadcasts and a reconnect's re-read alike, with
 * no per-request bookkeeping.
 */
export interface AssistantsState {
  /** Every known row by id, tombstones included. A new Map on every change. */
  byId: ReadonlyMap<number, AssistantInfo>
  /** True once a list read has succeeded. */
  hydrated: boolean
  /** The last read's failure, cleared by the next success. */
  loadError: string | null
  /** A reorder still in flight: the order to show until it settles. Kept out
   *  of the rows on purpose — editing a row locally without a new revision
   *  would let a re-read of the old content look "the same" and stick. */
  pendingOrder: readonly number[] | null

  fetchAll: () => Promise<void>
  applyChange: (change: AssistantChange) => void
  /** Merge whole rows by the revision rule. */
  merge: (rows: readonly AssistantInfo[]) => void
  create: (draft: AssistantDraft) => Promise<AssistantInfo>
  update: (id: number, patch: AssistantPatch) => Promise<AssistantInfo>
  remove: (id: number) => Promise<AssistantInfo>
  /** Persist the order after a drag (the complete live list, first to last).
   *  Shows at once; the rows' own order takes over when the latest settles.
   *  Writes run one at a time, and one superseded while queued is skipped. */
  reorder: (orderedIds: readonly number[]) => Promise<void>
}

/** `rows` merged into `current` by the revision rule, or `null` when nothing
 *  changed (so no consumer re-renders for an echo). */
export function mergeAssistantRows(
  current: ReadonlyMap<number, AssistantInfo>,
  rows: readonly AssistantInfo[]
): Map<number, AssistantInfo> | null {
  let next: Map<number, AssistantInfo> | null = null
  for (const row of rows) {
    const held = (next ?? current).get(row.id)
    if (held && held.revision >= row.revision) continue
    next ??= new Map(current)
    next.set(row.id, row)
  }
  return next
}

let fetchSeq = 0
let lastAppliedFetch = 0
let reorderSeq = 0
/** The reorder write in flight, if any: writes run one at a time, in order. */
let reorderTail: Promise<unknown> = Promise.resolve()

export const useAssistantsStore = create<AssistantsState>()((set, get) => ({
  byId: new Map(),
  hydrated: false,
  loadError: null,
  pendingOrder: null,

  merge: (rows) => {
    const next = mergeAssistantRows(get().byId, rows)
    if (next) set({ byId: next })
  },

  fetchAll: async () => {
    const id = ++fetchSeq
    try {
      const rows = await assistantList()
      // An older read is a strictly earlier view; the revision rule would keep
      // it from rolling anything back anyway, this only saves the work.
      if (id < lastAppliedFetch) return
      lastAppliedFetch = id
      get().merge(rows)
      set({ hydrated: true, loadError: null })
    } catch (err) {
      console.error("[Assistants] fetch failed:", err)
      set({ loadError: toErrorMessage(err) })
    }
  },

  applyChange: (change) => {
    switch (change.kind) {
      case "upsert":
        get().merge([change.assistant])
        return
      case "reordered":
        get().merge(change.assistants)
        return
      case "resync":
        void get().fetchAll()
        return
    }
  },

  create: async (draft) => {
    const row = await assistantCreate(draft)
    get().merge([row])
    return get().byId.get(row.id) ?? row
  },

  update: async (id, patch) => {
    const row = await assistantUpdate(id, patch)
    get().merge([row])
    return get().byId.get(row.id) ?? row
  },

  remove: async (id) => {
    const tombstone = await assistantDelete(id)
    get().merge([tombstone])
    return tombstone
  },

  reorder: async (orderedIds) => {
    const seq = ++reorderSeq
    const order = [...orderedIds]
    set({ pendingOrder: order })
    // One write at a time, in the order asked: two in flight together could
    // commit the other way round, and the later move would be lost. A write
    // still queued when a newer order arrives is skipped — the newer one
    // already carries it.
    const write = reorderTail.then(async () => {
      if (seq !== reorderSeq) return
      get().merge(await assistantReorder(order))
    })
    reorderTail = write.catch(() => {})
    try {
      await write
    } catch (err) {
      // The rows were never touched; re-read in case the write landed before
      // its reply was lost.
      void get().fetchAll()
      throw err
    } finally {
      if (seq === reorderSeq) set({ pendingOrder: null })
    }
  },
}))

/** Live assistants in display order: a pending reorder's order first, then
 *  `sort_order`, ties on `id`. */
export function orderedLiveAssistants(
  byId: ReadonlyMap<number, AssistantInfo>,
  pendingOrder: readonly number[] | null
): AssistantInfo[] {
  const live = [...byId.values()].filter((a) => a.deleted_at === null)
  const pending = pendingOrder
    ? new Map(pendingOrder.map((id, idx) => [id, idx]))
    : null
  return live.sort((a, b) => {
    if (pending) {
      const pa = pending.get(a.id)
      const pb = pending.get(b.id)
      if (pa !== undefined && pb !== undefined && pa !== pb) return pa - pb
    }
    return a.sort_order - b.sort_order || a.id - b.id
  })
}

/** Live assistants, in display order. */
export function useAssistants(): AssistantInfo[] {
  const byId = useAssistantsStore((s) => s.byId)
  const pendingOrder = useAssistantsStore((s) => s.pendingOrder)
  return useMemo(
    () => orderedLiveAssistants(byId, pendingOrder),
    [byId, pendingOrder]
  )
}

/** One assistant by id — a tombstone included — or `undefined` when this
 *  window has never seen it. */
export function useAssistant(
  id: number | null | undefined
): AssistantInfo | undefined {
  return useAssistantsStore((s) => (id == null ? undefined : s.byId.get(id)))
}

/** Restore the pristine state. Tests and the backend-scoped reset only. */
export function resetAssistantsStore(): void {
  fetchSeq = 0
  lastAppliedFetch = 0
  reorderSeq = 0
  reorderTail = Promise.resolve()
  useAssistantsStore.setState(useAssistantsStore.getInitialState(), true)
}

registerBackendScopedStoreReset(resetAssistantsStore)

/**
 * Keep this window's assistants live: every `assistant://changed` broadcast
 * merged in place, one read once broadcasts reach this window, and a re-read
 * after a WebSocket reconnect (the broadcaster drops what fires while nobody
 * is listening). Mount once per window: the workspace layout does, and so does
 * the settings page's assistants panel (the settings window has no workspace
 * layout).
 *
 * The read waits for the subscription — on a WebSocket transport that is the
 * server confirming its receiver — because a write landing between a read
 * taken earlier and the subscription would reach neither, for good.
 */
export function useAssistantsSync(): void {
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined

    void (async () => {
      try {
        const dispose = await subscribe<AssistantChange>(
          ASSISTANT_CHANGED_EVENT,
          (change) => {
            useAssistantsStore.getState().applyChange(change)
          }
        )
        if (disposed) {
          dispose()
          return
        }
        unlisten = dispose
      } catch (err) {
        // Not live, but still worth a read: a reconnect re-reads again.
        console.error("[Assistants] subscribe failed:", err)
      }
      if (!disposed) void useAssistantsStore.getState().fetchAll()
    })()

    const offReconnect = onTransportReconnect(() => {
      void useAssistantsStore.getState().fetchAll()
    })

    return () => {
      disposed = true
      unlisten?.()
      offReconnect?.()
    }
  }, [])
}

/** The bridge component for layouts: mounts {@link useAssistantsSync}. */
export function AssistantsSync(): null {
  useAssistantsSync()
  return null
}
