"use client"

/**
 * Whether the hidden assistants are listed (D6): off by default, kept on
 * this device. The sidebar's assistants and the page title's popover read
 * the one setting, and a change in either shows in both at once.
 */

import { useSyncExternalStore } from "react"

const SHOW_HIDDEN_KEY = "pa:roster:show-hidden:v1"

const listeners = new Set<() => void>()

function read(): boolean {
  if (typeof window === "undefined") return false
  try {
    return window.localStorage.getItem(SHOW_HIDDEN_KEY) === "1"
  } catch {
    return false
  }
}

let value: boolean | null = null

function current(): boolean {
  if (value === null) value = read()
  return value
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Show the hidden assistants, or not. */
export function setShowHiddenAssistants(on: boolean): void {
  value = on
  try {
    if (on) window.localStorage.setItem(SHOW_HIDDEN_KEY, "1")
    else window.localStorage.removeItem(SHOW_HIDDEN_KEY)
  } catch {
    // Not kept; shown for now all the same.
  }
  for (const l of listeners) l()
}

/** Whether the hidden assistants are listed, and the way to change it. */
export function useShowHiddenAssistants(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, current, () => false)
  return [on, setShowHiddenAssistants]
}

/** For tests: forget what was read. */
export function resetShowHiddenAssistantsForTest(): void {
  value = null
}
