"use client"

/**
 * Taskbar / Dock attention preferences: the master switch, and how strongly
 * each agent event asks the OS to point the user back at the window.
 *
 * Same storage shape and reactive plumbing as `desktop-notification-prefs.ts`,
 * for the same reason: this is a per-device concern. It is also desktop-only —
 * a browser tab has no taskbar button or Dock icon of its own to flash — so a
 * web client never reads these at all.
 *
 * The event catalogue IS the desktop-notification one, on purpose: both answer
 * "something happened while you were away, come back", one with a banner and
 * one with the window's own taskbar entry. Sharing the ids keeps the two
 * settings sections reading as one list, and makes the type checker demand a
 * level here for every event notifications learn about.
 */

import { useSyncExternalStore } from "react"

import {
  NOTIFY_EVENT_IDS,
  type NotifyEventId,
} from "./desktop-notification-prefs"

const PREFS_KEY = "settings:window-attention:v1"
const PREFS_EVENT = "codeg:window-attention-changed"

/** Events that can request attention, in display order. */
export const ATTENTION_EVENT_IDS = NOTIFY_EVENT_IDS

export type AttentionEventId = NotifyEventId

/**
 * How hard an event asks, named after the platform request it maps to (Tauri's
 * `UserAttentionType`):
 *
 *   - `informational` — macOS bounces the Dock icon once; Windows flashes the
 *     taskbar button a few times and leaves it highlighted until the window is
 *     activated.
 *   - `critical` — macOS keeps the Dock icon bouncing, and Windows keeps the
 *     button flashing, until the user comes back to the app.
 *
 * Linux has one urgency hint and no levels, so both set the same mark there.
 */
export const ATTENTION_LEVEL_IDS = ["off", "informational", "critical"] as const

export type AttentionLevel = (typeof ATTENTION_LEVEL_IDS)[number]

export interface WindowAttentionPrefs {
  /** Master switch. */
  enabled: boolean
  /** Level per event; `off` silences that event without touching the rest. */
  levels: Record<AttentionEventId, AttentionLevel>
}

/**
 * On out of the box, unlike the notification sounds' default-off: a request
 * for attention is silent, does nothing while the window is focused, and is
 * the platform's own convention for "this app needs you" — the same mark a
 * chat app or a terminal bell leaves. The events that leave an agent BLOCKED on
 * the user keep asking until they come back; the ones that only report news
 * ask once.
 */
export const DEFAULT_WINDOW_ATTENTION_PREFS: WindowAttentionPrefs = {
  enabled: true,
  levels: {
    turn_complete: "informational",
    permission_request: "critical",
    question_request: "critical",
    error: "informational",
    background_task: "informational",
    work_task: "informational",
  },
}

function isAttentionLevel(value: unknown): value is AttentionLevel {
  return (
    typeof value === "string" &&
    (ATTENTION_LEVEL_IDS as readonly string[]).includes(value)
  )
}

function defaultPrefs(): WindowAttentionPrefs {
  const defaults = DEFAULT_WINDOW_ATTENTION_PREFS
  return { ...defaults, levels: { ...defaults.levels } }
}

/**
 * Merge a stored blob over the defaults, field by field, so a partial write
 * from an older build (or a hand-edited value) degrades to that one default
 * instead of discarding the whole set — the rule every sibling prefs module
 * follows.
 */
export function parseWindowAttentionPrefs(raw: unknown): WindowAttentionPrefs {
  const parsed = defaultPrefs()
  if (!raw || typeof raw !== "object") return parsed
  const source = raw as Record<string, unknown>

  if (typeof source.enabled === "boolean") parsed.enabled = source.enabled

  const storedLevels = source.levels
  if (storedLevels && typeof storedLevels === "object") {
    const entries = storedLevels as Record<string, unknown>
    for (const id of ATTENTION_EVENT_IDS) {
      const level = entries[id]
      if (isAttentionLevel(level)) parsed.levels[id] = level
    }
  }

  return parsed
}

export function loadWindowAttentionPrefs(): WindowAttentionPrefs {
  if (typeof window === "undefined") return defaultPrefs()
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return defaultPrefs()
    return parseWindowAttentionPrefs(JSON.parse(raw))
  } catch {
    return defaultPrefs()
  }
}

export function saveWindowAttentionPrefs(prefs: WindowAttentionPrefs): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    /* ignore */
  }
  // Same-window listeners; other windows (the workspace, when this was written
  // from the Settings window) get the native `storage` event.
  window.dispatchEvent(new CustomEvent(PREFS_EVENT, { detail: prefs }))
}

// ── Shared snapshot ──
//
// One memoized copy per window, invalidated by a write here or in another
// window. The settings panel reads it through `useSyncExternalStore`, which
// needs a stable identity between renders; the request gate reads it on the
// ACP event path, which must not re-parse JSON per event.

let snapshot: WindowAttentionPrefs | null = null
const listeners = new Set<() => void>()
let windowBound = false

function bindWindow(): void {
  if (windowBound || typeof window === "undefined") return
  windowBound = true
  const invalidate = () => {
    snapshot = null
    for (const listener of listeners) listener()
  }
  window.addEventListener(PREFS_EVENT, invalidate)
  window.addEventListener("storage", invalidate)
}

/**
 * Current preferences, memoized. Identity only changes when the stored value
 * does, so it is safe as a `useSyncExternalStore` snapshot.
 */
export function getWindowAttentionPrefs(): WindowAttentionPrefs {
  // Reading is enough to start tracking changes — the workspace window only
  // ever reads, and would otherwise keep a stale copy after the Settings
  // window wrote a new one.
  bindWindow()
  if (typeof window === "undefined") return DEFAULT_WINDOW_ATTENTION_PREFS
  snapshot ??= loadWindowAttentionPrefs()
  return snapshot
}

/** Subscribe to preference changes from this window or any other. */
export function subscribeWindowAttentionPrefs(
  onChange: () => void
): () => void {
  bindWindow()
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

/** Stable pre-hydration value for the statically exported HTML. */
function getServerWindowAttentionPrefs(): WindowAttentionPrefs {
  return DEFAULT_WINDOW_ATTENTION_PREFS
}

/** Reactive read of the preferences; live across windows. */
export function useWindowAttentionPrefs(): WindowAttentionPrefs {
  return useSyncExternalStore(
    subscribeWindowAttentionPrefs,
    getWindowAttentionPrefs,
    getServerWindowAttentionPrefs
  )
}

/** Test seam: forget the memoized snapshot so the next read hits storage. */
export function resetWindowAttentionPrefsCacheForTests(): void {
  snapshot = null
}
