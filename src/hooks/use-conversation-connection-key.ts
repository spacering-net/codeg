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

// Recording starts when this module loads (with the app bundle), not when the
// first sidebar card mounts: a collapsed sidebar renders no cards, and a draft
// bound and closed meanwhile must still be remembered. Never unsubscribes — the
// map serves the whole app session. Imported from the store module itself
// rather than `@/contexts/tab-context`, so tests mocking that context with a
// selector-only hook still load this module.
rememberConversationTabs(useTabStore.getState().tabs)
useTabStore.subscribe((state, prev) => {
  if (state.tabs !== prev.tabs) rememberConversationTabs(state.tabs)
})

/** The connection key for a conversation's live state: its open tab's id, else
 *  the id of the tab it was last open in, else the canonical tab id. */
export function useConversationConnectionKey(
  folderId: number,
  agentType: AgentType,
  conversationId: number
): string {
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
