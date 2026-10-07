"use client"

/**
 * Desktop-notification preferences: the master switch, which agent events are
 * allowed to raise an OS notification, when they may do so, and whether the
 * notification body may carry agent output.
 *
 * Same storage shape and reactive plumbing as `notification-sound-prefs.ts`,
 * for the same reason: where a notification lands is a per-device concern. A
 * phone browser attached to the same `codeg-server` must not start buzzing
 * because the desktop was configured to.
 *
 * The event catalogue is deliberately NOT identical to the sound one. Sounds
 * mirror the chat-channel Events tab (five ACP-level triggers). Notifications
 * mirror what the app actually notifies about, which includes two app-level
 * sources the ACP event stream has no envelope for — a settled background task
 * and a work task flipping into review — and excludes `user_prompt_sent`, an
 * echo of the user's own keystroke that has no business in a notification
 * centre.
 */

import { useSyncExternalStore } from "react"

const PREFS_KEY = "settings:desktop-notification:v1"
const PREFS_EVENT = "codeg:desktop-notification-changed"

/** Events that can raise an OS notification, in display order. */
export const NOTIFY_EVENT_IDS = [
  "turn_complete",
  "permission_request",
  "question_request",
  "error",
  "background_task",
  "work_task",
] as const

export type NotifyEventId = (typeof NOTIFY_EVENT_IDS)[number]

/**
 * How much of the window's state gates delivery.
 *
 * `hidden` is what the app did before this preference existed, and stays the
 * default. It is also the strictest: a desktop window sitting visible on a
 * second monitor is NOT hidden, so `hidden` never fires for it — which is
 * exactly the "I never get notifications" report `unfocused` answers.
 */
export const NOTIFY_WHEN_IDS = ["always", "unfocused", "hidden"] as const

export type NotifyWhen = (typeof NOTIFY_WHEN_IDS)[number]

export interface DesktopNotificationPrefs {
  /** Master switch. */
  enabled: boolean
  /** Window state required before a notification is delivered. */
  when: NotifyWhen
  /**
   * Replace the body with a generic line, so agent output never reaches the OS
   * notification centre — which persists it outside the app, past the point
   * where closing the conversation would have disposed of it.
   */
  hideBody: boolean
  /** Per-event switch; an event turned off here is silent without affecting the rest. */
  events: Record<NotifyEventId, boolean>
}

/**
 * Everything on, delivering only while the window is hidden.
 *
 * This is the pre-existing behaviour spelled out as data, and that is the whole
 * point: desktop notifications already shipped, so an upgrade that introduced
 * this preference file must not be the release that silently stops delivering
 * them. (Contrast `notification-sound-prefs.ts`, which defaults its master
 * switch OFF — audio was new there, and a quiet install must stay quiet.)
 */
export const DEFAULT_DESKTOP_NOTIFICATION_PREFS: DesktopNotificationPrefs = {
  enabled: true,
  when: "hidden",
  hideBody: false,
  events: {
    turn_complete: true,
    permission_request: true,
    question_request: true,
    error: true,
    background_task: true,
    work_task: true,
  },
}

function isNotifyWhen(value: unknown): value is NotifyWhen {
  return (
    typeof value === "string" &&
    (NOTIFY_WHEN_IDS as readonly string[]).includes(value)
  )
}

/**
 * Merge a stored blob over the defaults, field by field. Every field is
 * validated on its own so a partial write from an older build (or a
 * hand-edited value) degrades to that one default instead of discarding the
 * whole preference set — the same rule `parseNotificationSoundPrefs` follows.
 */
export function parseDesktopNotificationPrefs(
  raw: unknown
): DesktopNotificationPrefs {
  const defaults = DEFAULT_DESKTOP_NOTIFICATION_PREFS
  if (!raw || typeof raw !== "object") {
    return { ...defaults, events: { ...defaults.events } }
  }
  const source = raw as Record<string, unknown>

  const events = { ...defaults.events }
  const storedEvents = source.events
  if (storedEvents && typeof storedEvents === "object") {
    const entries = storedEvents as Record<string, unknown>
    for (const id of NOTIFY_EVENT_IDS) {
      const value = entries[id]
      if (typeof value === "boolean") events[id] = value
    }
  }

  return {
    enabled:
      typeof source.enabled === "boolean" ? source.enabled : defaults.enabled,
    when: isNotifyWhen(source.when) ? source.when : defaults.when,
    hideBody:
      typeof source.hideBody === "boolean"
        ? source.hideBody
        : defaults.hideBody,
    events,
  }
}

export function loadDesktopNotificationPrefs(): DesktopNotificationPrefs {
  const defaults = DEFAULT_DESKTOP_NOTIFICATION_PREFS
  if (typeof window === "undefined") {
    return { ...defaults, events: { ...defaults.events } }
  }
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return { ...defaults, events: { ...defaults.events } }
    return parseDesktopNotificationPrefs(JSON.parse(raw))
  } catch {
    return { ...defaults, events: { ...defaults.events } }
  }
}

export function saveDesktopNotificationPrefs(
  prefs: DesktopNotificationPrefs
): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    /* ignore */
  }
  // Same-window listeners (the sender lives in the workspace window, which may
  // also host the settings route); other windows/tabs get the native `storage`
  // event.
  window.dispatchEvent(new CustomEvent(PREFS_EVENT, { detail: prefs }))
}

// ── Shared snapshot ──
//
// One memoized copy per window, invalidated by a write here or in another
// window/tab. Both consumers read through it: the settings panel (via
// `useSyncExternalStore`, which needs a stable identity between renders) and
// the delivery gate, which sits on the ACP event path and must not re-parse
// JSON per event.

let snapshot: DesktopNotificationPrefs | null = null
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
export function getDesktopNotificationPrefs(): DesktopNotificationPrefs {
  // Reading is enough to start tracking changes — the workspace window only
  // ever reads, and would otherwise hold a stale copy forever after the
  // settings window wrote a new one.
  bindWindow()
  if (typeof window === "undefined") return DEFAULT_DESKTOP_NOTIFICATION_PREFS
  snapshot ??= loadDesktopNotificationPrefs()
  return snapshot
}

/** Subscribe to preference changes from this window or any other. */
export function subscribeDesktopNotificationPrefs(
  onChange: () => void
): () => void {
  bindWindow()
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

/**
 * Stable pre-hydration value. The exported HTML is built without a browser, so
 * React renders the defaults on the server pass and swaps in the stored
 * preferences once hydrated.
 */
function getServerDesktopNotificationPrefs(): DesktopNotificationPrefs {
  return DEFAULT_DESKTOP_NOTIFICATION_PREFS
}

/** Reactive read of the preferences; live across windows. */
export function useDesktopNotificationPrefs(): DesktopNotificationPrefs {
  return useSyncExternalStore(
    subscribeDesktopNotificationPrefs,
    getDesktopNotificationPrefs,
    getServerDesktopNotificationPrefs
  )
}

/** Test seam: forget the memoized snapshot so the next read hits storage. */
export function resetDesktopNotificationPrefsCacheForTests(): void {
  snapshot = null
}
