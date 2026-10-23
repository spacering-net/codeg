"use client"

import {
  useEffect,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react"
import { onTransportReconnect, subscribe } from "@/lib/platform"
import {
  CONVERSATION_CHANGED_EVENT,
  type ConversationChange,
  type DbConversationSummary,
} from "@/lib/types"

type ChildrenMap = Map<number, DbConversationSummary[]>

// Descending by created_at (ISO-8601 strings sort lexicographically as time),
// id as a stable tie-break — matching the backend `list_children` ORDER BY
// created_at DESC, id DESC so an inserted child lands in the same position a
// refetch would. Newest-on-top puts a freshly-spawned sub-agent right under its
// parent, consistent with the root list.
function byCreatedAtDesc(
  a: DbConversationSummary,
  b: DbConversationSummary
): number {
  if (a.created_at > b.created_at) return -1
  if (a.created_at < b.created_at) return 1
  return b.id - a.id
}

// FIFO bound for the deleted-child tombstone set (mirrors the root list's
// DELETED_TOMBSTONE_CAP). DB ids are autoincrement and never reused, so each
// tombstone is permanent until FIFO-evicted.
const DELETED_TOMBSTONE_CAP = 512

/**
 * Real-time sync for the sidebar's delegation sub-session subtree.
 *
 * Roots are handled by `AppWorkspaceProvider`'s own `conversation://changed`
 * subscription (which ignores `parent_id != null`); this is its mirror for
 * CHILDREN. It keeps the lazily-loaded `childrenByParent` cache live so a
 * sub-agent spawned / advanced / removed in the background updates the expanded
 * tree without a refresh.
 *
 * `child_count` is NEVER mutated here. The backend re-emits a parent's upsert
 * whenever a child is created or deleted, so a parent's count (hence its
 * chevron) converges from the authoritative DB aggregate. A nested parent's
 * upsert is itself a child upsert (it carries its own `parent_id`), so the same
 * routing keeps grandparent arrays — and their counts — correct.
 *
 * Reference stability mirrors {@link groupByFolderWithReuse}: a single event
 * replaces exactly one summary object and rebuilds only the touched parent's
 * array, leaving every sibling's identity intact so the card `memo` bails out
 * through the virtualized render.
 */
export function useSubsessionSync(params: {
  setChildrenByParent: Dispatch<SetStateAction<ChildrenMap>>
  /** FIFO-bounded tombstones for soft-deleted child ids, shared with the list's
   *  `ensureChildrenLoaded` so a stale fetch snapshot or an out-of-order upsert
   *  can't resurrect a deleted child — the child-cache analog of the root list's
   *  deletion guard. */
  deletedChildIdsRef: RefObject<Set<number>>
  /** Lets a history loader buffer id-only updates before the child is known. */
  onStatus?: (id: number, status: string) => void
}): void {
  const { setChildrenByParent, deletedChildIdsRef, onStatus } = params

  useEffect(() => {
    // Insert-or-replace a child in its parent's loaded array (reuse-stable). A
    // parent whose children aren't loaded is left untouched — the lazy invariant
    // (only fetched subtrees materialize) holds; the chevron still appears via
    // the parent's own child_count upsert (routed here when the parent is itself
    // a child, or by the context when it's a root).
    const applyChildUpsert = (summary: DbConversationSummary) => {
      const parentId = summary.parent_id
      if (parentId == null) return
      // A stale / out-of-order upsert for an already-deleted child must not
      // resurrect it (mirrors the root list's tombstone guard).
      if (deletedChildIdsRef.current.has(summary.id)) return
      setChildrenByParent((prev) => {
        const existing = prev.get(parentId)
        if (existing === undefined) return prev
        const idx = existing.findIndex((c) => c.id === summary.id)
        let nextArr: DbConversationSummary[]
        if (idx >= 0) {
          if (existing[idx] === summary) return prev
          nextArr = existing.slice()
          nextArr[idx] = summary
        } else {
          nextArr = [...existing, summary].sort(byCreatedAtDesc)
        }
        const next = new Map(prev)
        next.set(parentId, nextArr)
        return next
      })
    }

    // Route a child status event (it carries only `{ id, status }`, no
    // parent_id) into whichever loaded parent holds it — found by scanning the
    // latest state INSIDE the updater, so there is no separate reverse index to
    // drift and no ref read during render. Unknown ids (a root, or a child whose
    // parent isn't loaded) leave the map untouched (identity stable).
    const applyChildStatus = (id: number, status: string) => {
      setChildrenByParent((prev) => {
        for (const [parentId, kids] of prev) {
          const idx = kids.findIndex((c) => c.id === id)
          if (idx < 0) continue
          if (kids[idx].status === status) return prev
          const nextArr = kids.slice()
          nextArr[idx] = {
            ...kids[idx],
            status,
            updated_at: new Date().toISOString(),
          }
          const next = new Map(prev)
          next.set(parentId, nextArr)
          return next
        }
        return prev
      })
    }

    const applyChildRemove = (id: number) => {
      // Tombstone the deleted id (FIFO-bounded) so a stale fetch snapshot or a
      // late upsert can't bring it back. Descendants need no tombstone: their
      // parent's cache entry is dropped below, so a late descendant upsert finds
      // no parent entry and is ignored.
      const tomb = deletedChildIdsRef.current
      tomb.add(id)
      if (tomb.size > DELETED_TOMBSTONE_CAP) {
        const oldest = tomb.values().next().value
        if (oldest !== undefined) tomb.delete(oldest)
      }
      setChildrenByParent((prev) => {
        let next: ChildrenMap | null = null
        // (a) Remove the child from its parent's array, if loaded.
        for (const [parentId, kids] of prev) {
          const idx = kids.findIndex((c) => c.id === id)
          if (idx >= 0) {
            const arr = kids.slice()
            arr.splice(idx, 1)
            next = next ?? new Map(prev)
            next.set(parentId, arr)
            break
          }
        }
        // (b) If the removed id was itself a loaded parent, drop its ENTIRE
        // cached descendant subtree. A deleted parent orphans its live children
        // (no DB cascade) and they have no other sidebar entry point; walk the
        // subtree so grandchild+ cache entries don't leak in a multi-level tree.
        if (prev.has(id)) {
          next = next ?? new Map(prev)
          const stack = [id]
          while (stack.length > 0) {
            const cur = stack.pop()!
            const kids = next.get(cur)
            if (kids === undefined) continue
            for (const k of kids) stack.push(k.id)
            next.delete(cur)
          }
        }
        return next ?? prev
      })
    }

    let disposed = false
    let unlisten: (() => void) | undefined
    void (async () => {
      const dispose = await subscribe<ConversationChange>(
        CONVERSATION_CHANGED_EVENT,
        (change) => {
          if (change.kind === "upsert") {
            applyChildUpsert(change.summary)
          } else if (change.kind === "status") {
            onStatus?.(change.id, change.status)
            applyChildStatus(change.id, change.status)
          } else {
            applyChildRemove(change.id)
          }
        }
      )
      if (disposed) dispose()
      else unlisten = dispose
    })()

    // On reconnect, drop the child cache so every still-expanded subtree
    // re-fetches fresh (events missed while disconnected are gone). The list's
    // restore-time guard re-runs `ensureChildrenLoaded` for expanded parents.
    // Returns null on desktop IPC (no disconnect window) → no-op there.
    const offReconnect = onTransportReconnect(() => {
      setChildrenByParent((prev) => (prev.size === 0 ? prev : new Map()))
    })

    return () => {
      disposed = true
      unlisten?.()
      offReconnect?.()
    }
  }, [setChildrenByParent, deletedChildIdsRef, onStatus])
}
