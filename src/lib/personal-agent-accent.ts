"use client"

/**
 * The assistants page's accent (10.7): the theme's, or each assistant's own
 * colour — the owner's bubbles, the cards' accent edges and buttons in its
 * conversation then take it. An appearance setting kept in this browser,
 * one key, read again when another window changes it.
 */

import { useCallback, useSyncExternalStore } from "react"

export type PaAccent = "default" | "bot"

export const PA_ACCENT_KEY = "appearance:pa-accent:v1"
const CHANGED = "codeg:pa-accent-changed"

function read(): PaAccent {
  try {
    return window.localStorage.getItem(PA_ACCENT_KEY) === "bot"
      ? "bot"
      : "default"
  } catch {
    return "default"
  }
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === PA_ACCENT_KEY) onChange()
  }
  window.addEventListener("storage", onStorage)
  window.addEventListener(CHANGED, onChange)
  return () => {
    window.removeEventListener("storage", onStorage)
    window.removeEventListener(CHANGED, onChange)
  }
}

export function setPaAccent(value: PaAccent): void {
  try {
    window.localStorage.setItem(PA_ACCENT_KEY, value)
  } catch {
    // Not kept; this window still follows it.
  }
  window.dispatchEvent(new Event(CHANGED))
}

/** The accent, and the way to change it. */
export function usePaAccent(): [PaAccent, (value: PaAccent) => void] {
  const value = useSyncExternalStore(subscribe, read, () => "default" as const)
  const set = useCallback((v: PaAccent) => setPaAccent(v), [])
  return [value, set]
}
