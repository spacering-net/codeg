"use client"

import { useTabStore } from "@/stores/tab-store"
import type { AgentType } from "@/lib/types"

function conversationKey(agentType: AgentType, conversationId: number) {
  return `${agentType}:${conversationId}`
}

/**
 * Conversation → the id of the last tab that showed it. A connection is keyed
 * by its tab id, and that id is not always the canonical `conv-…` one: a draft
 * that bound to the conversation keeps its `new-*` id, and a moved
 * conversation's tab keeps the old folder in its id. Closing such a tab while
 * its turn is busy (e.g. parked on a permission) leaves the connection running
 * under that id, so the sidebar must keep reading it after the tab is gone.
 * Module-level rather than per card: the sidebar list is virtualized, and a
 * row scrolled back into view must still find the key.
 */
const lastTabIdByConversation = new Map<string, string>()

function rememberConversationTabs(
  tabs: ReadonlyArray<{
    id: string
    conversationId?: number | null
    agentType?: AgentType | null
  }>
) {
  for (const tab of tabs) {
    if (tab.conversationId == null || tab.agentType == null) continue
    lastTabIdByConversation.set(
      conversationKey(tab.agentType, tab.conversationId),
      tab.id
    )
  }
}

let tracking = false

/** Starts recording on first use rather than at import, so merely importing
 *  this module never touches the store. Idempotent; never unsubscribes — the
 *  map serves the whole app session. */
function ensureTracking() {
  if (tracking) return
  tracking = true
  rememberConversationTabs(useTabStore.getState().tabs)
  useTabStore.subscribe((state, prev) => {
    if (state.tabs !== prev.tabs) rememberConversationTabs(state.tabs)
  })
}

/** The connection key for a conversation's live state: its open tab's id, else
 *  the id of the tab it was last open in, else the canonical tab id. */
export function useConversationConnectionKey(
  folderId: number,
  agentType: AgentType,
  conversationId: number
): string {
  ensureTracking()
  const openTabId = useTabStore(
    (state) =>
      state.tabs.find(
        (tab) =>
          tab.conversationId === conversationId && tab.agentType === agentType
      )?.id ?? null
  )
  return (
    openTabId ??
    lastTabIdByConversation.get(conversationKey(agentType, conversationId)) ??
    `conv-${folderId}-${agentType}-${conversationId}`
  )
}
