"use client"

/**
 * Whether the composer's `@` panel offers agents. When off, the Agents tab is
 * removed from the panel (so `@` can no longer insert an agent badge) and the
 * welcome tip that advertises agent mentions is skipped. Files, sessions and
 * commits stay mentionable either way.
 *
 * Stored in localStorage like the other composer/workspace display prefs
 * (`office-preview-prefs.ts`), so it works the same in the desktop app and in
 * a browser attached to a server. A custom event covers the current window and
 * the native `storage` event covers other windows/tabs, so flipping the switch
 * in Settings takes effect in an open composer immediately.
 */

import { useSyncExternalStore } from "react"

export const AGENT_MENTIONS_KEY = "composer:agent-mentions"
const AGENT_MENTIONS_EVENT = "codeg:agent-mentions-changed"

/** Default ON: only an explicit "false" hides agents from the `@` panel. */
export function loadAgentMentionsEnabled(): boolean {
  if (typeof window === "undefined") return true
  try {
    return localStorage.getItem(AGENT_MENTIONS_KEY) !== "false"
  } catch {
    return true
  }
}

export function saveAgentMentionsEnabled(value: boolean): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(AGENT_MENTIONS_KEY, String(value))
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent(AGENT_MENTIONS_EVENT, { detail: value }))
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key && event.key !== AGENT_MENTIONS_KEY) return
    onChange()
  }
  window.addEventListener(AGENT_MENTIONS_EVENT, onChange)
  window.addEventListener("storage", onStorage)
  return () => {
    window.removeEventListener(AGENT_MENTIONS_EVENT, onChange)
    window.removeEventListener("storage", onStorage)
  }
}

/** Reactive read of the preference; the static-export prerender sees ON. */
export function useAgentMentionsEnabled(): boolean {
  return useSyncExternalStore(subscribe, loadAgentMentionsEnabled, () => true)
}
