"use client"

import { useSyncExternalStore } from "react"

const STORAGE_KEY = "settings:chat-process-collapse:v1"
const CHANGE_EVENT = "codeg:chat-process-collapse-changed"

export const CHAT_PROCESS_COLLAPSE_MODES = [
  "current",
  "after-completion",
  "always",
] as const

export type ChatProcessCollapseMode =
  (typeof CHAT_PROCESS_COLLAPSE_MODES)[number]

export function getChatProcessCollapse(): ChatProcessCollapseMode {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value === "after-completion" || value === "always"
      ? value
      : "current"
  } catch {
    return "current"
  }
}

export function setChatProcessCollapse(mode: ChatProcessCollapseMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    return
  }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === STORAGE_KEY) onChange()
  }
  window.addEventListener(CHANGE_EVENT, onChange)
  window.addEventListener("storage", onStorage)
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange)
    window.removeEventListener("storage", onStorage)
  }
}

export function useChatProcessCollapse(): ChatProcessCollapseMode {
  return useSyncExternalStore(
    subscribe,
    getChatProcessCollapse,
    () => "current"
  )
}
