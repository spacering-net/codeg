"use client"

import { useEffect, useMemo, useRef, useState, type RefObject } from "react"
import type { ThreadRenderItem } from "./message-list-view"
import type { MessageScrollContextValue } from "./message-scroll-context"
import {
  clearConversationSearchJump,
  useConversationSearchStore,
} from "@/stores/conversation-search-store"

interface Options {
  conversationId: number
  dbConversationId: number
  enabled: boolean
  threadItems: readonly ThreadRenderItem[]
  scrollApiRef: RefObject<MessageScrollContextValue | null>
  loadOlderTurnsThrough: (id: number, throughIndex: number) => Promise<boolean>
  onUnavailable: () => void
}

const EMPTY_INDICES: ReadonlyMap<string, number> = new Map()

export function useConversationSearchJump({
  conversationId,
  dbConversationId,
  enabled,
  threadItems,
  scrollApiRef,
  loadOlderTurnsThrough,
  onUnavailable,
}: Options) {
  const target = useConversationSearchStore((state) =>
    state.target?.conversationId === dbConversationId ? state.target : null
  )
  const [highlightedTarget, setHighlightedTarget] = useState<{
    conversationId: number
    turnId: string
    token: number
    role?: "user" | "assistant"
  } | null>(null)
  const [settledToken, setSettledToken] = useState<number | null>(null)
  const searchPending = target != null
  const indices = useMemo(() => {
    if (!searchPending) return EMPTY_INDICES
    const result = new Map<string, number>()
    threadItems.forEach((item, index) => {
      if (item.kind !== "turn") return
      result.set(item.group.id, index)
      result.set(`${item.group.role}:${item.group.id}`, index)
      for (const turn of item.sourceTurns) {
        result.set(turn.id, index)
        result.set(`${item.group.role}:${turn.id}`, index)
        if (turn.source_turn_id) {
          result.set(turn.source_turn_id, index)
          result.set(`${item.group.role}:${turn.source_turn_id}`, index)
        }
      }
    })
    return result
  }, [threadItems, searchPending])
  const indicesRef = useRef(indices)
  const targetKey = target
    ? target.role
      ? `${target.role}:${target.turnId}`
      : target.turnId
    : null
  useEffect(() => {
    indicesRef.current = indices
  }, [indices])

  useEffect(() => {
    if (
      !enabled ||
      !target ||
      (targetKey != null && indicesRef.current.has(targetKey))
    )
      return
    let cancelled = false
    void loadOlderTurnsThrough(conversationId, target.turnIndex).then(
      () => {
        if (!cancelled) setSettledToken(target.token)
      },
      () => {
        if (!cancelled) setSettledToken(target.token)
      }
    )
    return () => {
      cancelled = true
    }
  }, [enabled, target, targetKey, conversationId, loadOlderTurnsThrough])

  const index = targetKey != null ? indices.get(targetKey) : undefined
  useEffect(() => {
    if (!enabled || !target) return
    if (index == null && settledToken !== target.token) return
    const frame = requestAnimationFrame(() => {
      if (useConversationSearchStore.getState().target?.token !== target.token)
        return
      if (index == null) {
        clearConversationSearchJump(target.token)
        onUnavailable()
        return
      }
      if (!scrollApiRef.current) return
      scrollApiRef.current.scrollToIndex(index, {
        align: "start",
        smooth: false,
      })
      setHighlightedTarget({
        conversationId: dbConversationId,
        turnId: target.turnId,
        token: target.token,
        role: target.role,
      })
      clearConversationSearchJump(target.token)
    })
    return () => cancelAnimationFrame(frame)
  }, [
    enabled,
    target,
    index,
    settledToken,
    scrollApiRef,
    onUnavailable,
    dbConversationId,
  ])

  return {
    highlightedTarget:
      highlightedTarget?.conversationId === dbConversationId
        ? highlightedTarget
        : null,
  }
}
