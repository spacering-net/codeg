"use client"

import { useSyncExternalStore } from "react"

import {
  useOptionalConnectionStore,
  type ConnectionStoreApi,
} from "@/contexts/acp-connections-context"
import {
  blockingPromptKind,
  blockingPrompts,
  type BlockingPromptKind,
} from "@/lib/blocking-prompts"
import type { AttentionIndex } from "@/lib/conversation-attention"

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
  const subscribe = (onChange: () => void) =>
    store ? store.subscribeAttention(onChange) : () => {}
  const getSnapshot = () => store?.getAttention()
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot) ?? null
}

/**
 * One conversation's blocking prompt, or `null` when it waits on nobody.
 *
 * For a component that already sits inside that conversation's own surface (the
 * detail header): it subscribes to that ONE key, so a prompt on the surface the
 * user is looking at re-renders nothing else. A list should read
 * {@link useConversationAttentionIndex} instead.
 *
 * `contextKey` is the connection's key (a tab id), not a DB conversation id.
 */
export function useAwaitingAnswer(
  contextKey: string | null | undefined
): BlockingPromptKind | null {
  const store = useOptionalConnectionStore()
  const subscribe = (onChange: () => void) =>
    store && contextKey ? store.subscribeKey(contextKey, onChange) : () => {}
  const getSnapshot = () =>
    store && contextKey ? awaitingAnswerOf(store, contextKey) : null
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

function awaitingAnswerOf(
  store: ConnectionStoreApi,
  contextKey: string
): BlockingPromptKind | null {
  const conn = store.getConnection(contextKey)
  // A delegated sub-agent's prompt belongs to the parent's card, which reads
  // the child connection itself; it is not a session the user "has open".
  if (!conn || conn.isDelegationChild) return null
  return blockingPromptKind(blockingPrompts(conn))
}
