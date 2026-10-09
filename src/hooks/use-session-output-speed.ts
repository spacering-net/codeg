"use client"

import { useCallback, useSyncExternalStore } from "react"

import {
  getSessionOutputSpeed,
  subscribeSessionOutputSpeed,
  type SessionOutputSpeed,
} from "@/lib/session-output-speed"

export function useSessionOutputSpeed(
  conversationId: number | null | undefined
): SessionOutputSpeed | null {
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeSessionOutputSpeed(onStoreChange),
    []
  )
  const getSnapshot = useCallback(
    () => getSessionOutputSpeed(conversationId),
    [conversationId]
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
