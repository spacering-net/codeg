"use client"

import { useSyncExternalStore } from "react"

const KEY = "workspace:chat-html-rendering"
const listeners = new Set<() => void>()
let unstored: boolean | undefined

function read(): boolean {
  if (unstored !== undefined) return unstored
  if (typeof window === "undefined") return false
  try {
    return localStorage.getItem(KEY) === "true"
  } catch {
    return false
  }
}

function notify() {
  for (const listener of listeners) listener()
}

function onStorage(event: StorageEvent) {
  if (event.key !== null && event.key !== KEY) return
  unstored = undefined
  notify()
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) window.addEventListener("storage", onStorage)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) window.removeEventListener("storage", onStorage)
  }
}

/** 修改立即通知本窗口；其他设置窗口通过 storage 事件同步。 */
export function saveChatHtmlEnabled(enabled: boolean) {
  try {
    localStorage.setItem(KEY, String(enabled))
    unstored = undefined
  } catch {
    unstored = enabled
  }
  notify()
}

export function useChatHtmlEnabled(): boolean {
  return useSyncExternalStore(subscribe, read, () => false)
}
