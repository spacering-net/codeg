"use client"

import { useCallback, useSyncExternalStore } from "react"
import { useConnectionStore } from "@/contexts/acp-connections-context"
import { useTabStore } from "@/contexts/tab-context"
import { useConversationRuntimeStore } from "@/stores/conversation-runtime-store"

/**
 * What the row below a composer reads about its own conversation. Scoped by
 * `tabId`, so every loaded / tiled composer shows its own session rather than
 * the active one's.
 */

/** This tab's connection (live context window, plan windows, status). */
export function useComposerConnection(tabId: string | null) {
  const store = useConnectionStore()
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!tabId) return () => {}
      return store.subscribeKey(tabId, cb)
    },
    [store, tabId]
  )
  const getSnapshot = useCallback(
    () => (tabId ? store.getConnection(tabId) : undefined),
    [store, tabId]
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * This tab's conversation's session stats, read straight from the runtime
 * store where every panel already keeps them — keyed by the tab's runtime
 * conversation id, the same resolution the panel uses for
 * `effectiveConversationId` (runtimeConversationId ?? conversationId).
 */
export function useComposerSessionStats(tabId: string | null) {
  const runtimeConversationId = useTabStore((s) => {
    const tab = s.tabs.find((x) => x.id === tabId)
    if (!tab || tab.kind !== "conversation") return null
    return tab.runtimeConversationId ?? tab.conversationId ?? null
  })
  return useConversationRuntimeStore((s) =>
    runtimeConversationId != null
      ? (s.byConversationId.get(runtimeConversationId)?.sessionStats ?? null)
      : null
  )
}
