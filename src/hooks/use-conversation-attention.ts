"use client"

import { useCallback, useSyncExternalStore } from "react"

import { useOptionalConnectionStore } from "@/contexts/acp-connections-context"
import type { BlockingPromptKind } from "@/lib/blocking-prompts"
import type { AttentionIndex } from "@/lib/conversation-attention"

const NO_SUBSCRIPTION = () => () => {}

/**
 * Every conversation parked on the user, as one reference-stable index.
 *
 * For a surface that marks a whole LIST (the sidebar, a folder header's count).
 * Subscribe ONCE here and hand each row the value it needs — subscribing per
 * row would add a store subscription to every visible conversation, and one
 * prompt would then re-render the entire list.
 *
 * `null` outside `AcpConnectionsProvider` (the activity gallery, component
 * tests): nothing is known, so nothing is marked.
 */
export function useConversationAttentionIndex(): AttentionIndex | null {
  const store = useOptionalConnectionStore()
  const subscribe = useCallback(
    (onChange: () => void) =>
      store ? store.subscribeAttention(onChange) : () => {},
    [store]
  )
  const getSnapshot = useCallback(() => store?.getAttention() ?? null, [store])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * One conversation's blocking prompt, or `null` when it waits on nobody.
 *
 * Reads the same index as the sidebar, keyed by the persisted conversation id,
 * so a tab and its sidebar row can never disagree — including when the prompt
 * is raised by a delegated sub-agent, which the index attributes to its parent
 * conversation. The snapshot is a primitive, so a change re-renders only the
 * component whose own mark moved. For a few marks at a time (the tab strip); a
 * long list should read {@link useConversationAttentionIndex} once instead.
 */
export function useAwaitingAnswer(
  conversationId: number | null | undefined
): BlockingPromptKind | null {
  const store = useOptionalConnectionStore()
  const subscribe = useCallback(
    (onChange: () => void) =>
      store && conversationId != null
        ? store.subscribeAttention(onChange)
        : NO_SUBSCRIPTION(),
    [store, conversationId]
  )
  const getSnapshot = useCallback(
    () =>
      store && conversationId != null
        ? (store.getAttention().get(conversationId) ?? null)
        : null,
    [store, conversationId]
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
