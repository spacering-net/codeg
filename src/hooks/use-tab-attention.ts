"use client"

import { useCallback, useRef, useSyncExternalStore } from "react"
import { useConnectionStore } from "@/contexts/acp-connections-context"
import {
  connectionAttentionKind,
  type TabAttentionKind,
} from "@/lib/tab-arrangement"

const NO_ATTENTION: ReadonlyMap<string, TabAttentionKind> = new Map()

function sameAttention(
  a: ReadonlyMap<string, TabAttentionKind>,
  b: ReadonlyMap<string, TabAttentionKind>
): boolean {
  if (a.size !== b.size) return false
  for (const [tabId, kind] of a) {
    if (b.get(tabId) !== kind) return false
  }
  return true
}

/**
 * Which of `tabIds` are blocked waiting on the user, and on what — read live
 * from each tab's own ACP connection (a conversation tab's id is its
 * connection `contextKey`). A tab with no connection has nothing pending.
 *
 * Every streaming batch notifies its connection's key, so the map keeps its
 * identity until an entry actually changes: a busy session does not re-render
 * the caller per token. Pass a memoized `tabIds` — a new array re-subscribes
 * every key.
 */
export function useTabAttention(
  tabIds: readonly string[]
): ReadonlyMap<string, TabAttentionKind> {
  const store = useConnectionStore()
  const subscribe = useCallback(
    (onChange: () => void) => {
      const unsubscribes = tabIds.map((id) => store.subscribeKey(id, onChange))
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe()
      }
    },
    [store, tabIds]
  )
  const cacheRef = useRef(NO_ATTENTION)
  const getSnapshot = useCallback(() => {
    const next = new Map<string, TabAttentionKind>()
    for (const id of tabIds) {
      const kind = connectionAttentionKind(store.getConnection(id))
      if (kind) next.set(id, kind)
    }
    if (sameAttention(cacheRef.current, next)) return cacheRef.current
    cacheRef.current = next
    return next
  }, [store, tabIds])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
