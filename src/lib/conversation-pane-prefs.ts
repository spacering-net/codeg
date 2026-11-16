"use client"

import { useSyncExternalStore } from "react"

export const CONVERSATION_PANES_PREF_KEY =
  "settings:conversation-panes-enabled:v1"
const PREF_EVENT = "codeg:conversation-panes-preference-changed"
let fallback = false
let storageUnavailable = false

export function getConversationPanesEnabled(): boolean {
  if (typeof window === "undefined") return false
  if (storageUnavailable) return fallback
  try {
    return localStorage.getItem(CONVERSATION_PANES_PREF_KEY) === "true"
  } catch {
    return fallback
  }
}

export function saveConversationPanesEnabled(enabled: boolean): void {
  fallback = enabled
  try {
    localStorage.setItem(CONVERSATION_PANES_PREF_KEY, String(enabled))
    storageUnavailable = false
  } catch {
    // 隐私模式或存储配额不足时，仍允许在当前窗口使用开关。
    storageUnavailable = true
  }
  window.dispatchEvent(new Event(PREF_EVENT))
}

export function subscribeConversationPanesPreference(
  onChange: () => void
): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== CONVERSATION_PANES_PREF_KEY) return
    storageUnavailable = false
    onChange()
  }
  window.addEventListener(PREF_EVENT, onChange)
  window.addEventListener("storage", onStorage)
  return () => {
    window.removeEventListener(PREF_EVENT, onChange)
    window.removeEventListener("storage", onStorage)
  }
}

const serverSnapshot = () => false

export function useConversationPanesEnabled(): boolean {
  return useSyncExternalStore(
    subscribeConversationPanesPreference,
    getConversationPanesEnabled,
    serverSnapshot
  )
}
