"use client"

import { useCallback, useSyncExternalStore } from "react"
import { useOptionalConnectionStore } from "@/contexts/acp-connections-context"
import { blockingPrompts } from "@/lib/blocking-prompts"

const NO_SUBSCRIPTION = () => () => {}
const NOT_WAITING = () => false

/**
 * Whether the connection at `contextKey` is parked on the user — the same
 * `blockingPrompts` notion the conversation panel's `awaitingUser` and the
 * live-runs chip use, so the sidebar and tab strip never disagree with them.
 * Re-renders only when that boolean flips, not on every connection update.
 */
export function useConnectionWaiting(contextKey: string): boolean {
  const store = useOptionalConnectionStore()
  const subscribe = useCallback(
    (notify: () => void) =>
      store ? store.subscribeKey(contextKey, notify) : NO_SUBSCRIPTION(),
    [contextKey, store]
  )
  const getSnapshot = useCallback(
    () => blockingPrompts(store?.getConnection(contextKey)) !== null,
    [contextKey, store]
  )

  // Sidebar and tab-strip snapshots may render before the connection store exists.
  return useSyncExternalStore(subscribe, getSnapshot, NOT_WAITING)
}
