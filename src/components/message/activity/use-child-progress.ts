"use client"

import { useCallback, useSyncExternalStore } from "react"

import { useOptionalConnectionStore } from "@/contexts/acp-connections-context"
import {
  progressFromLiveContent,
  progressKey,
  type StepProgress,
} from "@/lib/activity/progress"

/** Last value handed out per connection, so an unchanged tally keeps its
 *  identity. Bounded like the other module-level row caches. */
const MAX_CACHED = 64
const cache = new Map<string, { key: string; value: StepProgress | null }>()

function remember(
  connectionId: string,
  key: string,
  value: StepProgress | null
) {
  cache.delete(connectionId)
  cache.set(connectionId, { key, value })
  if (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
}

/**
 * The live progress of a delegated agent's own connection, from its message's
 * tool calls. Re-renders only when the tally changes: the child streams text
 * many times a second, and only its tool calls move this. `null` without a
 * connection id, outside a connection store, or while the child's turn has
 * called no tool.
 */
export function useChildProgress(
  connectionId: string | null
): StepProgress | null {
  const store = useOptionalConnectionStore()
  const subscribe = useCallback(
    (onChange: () => void) =>
      store && connectionId
        ? store.subscribeKey(connectionId, onChange)
        : () => {},
    [store, connectionId]
  )
  const getSnapshot = useCallback((): StepProgress | null => {
    if (!store || !connectionId) return null
    const content = store.getConnection(connectionId)?.liveMessage?.content
    const next = content ? progressFromLiveContent(content) : null
    const key = progressKey(next)
    const cached = cache.get(connectionId)
    if (cached && cached.key === key) return cached.value
    remember(connectionId, key, next)
    return next
  }, [store, connectionId])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
