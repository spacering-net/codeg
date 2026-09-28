"use client"

/**
 * OS notifications for agent events — the gate every feature call site goes
 * through.
 *
 * Structurally the twin of `notification-sound.ts`: an event id, the stored
 * preferences, a window-state gate and a cooldown, then a platform call. The
 * two are kept as separate modules rather than one "alerting" module because
 * their gates genuinely differ — a sound is discardable and a notification is
 * not, so the throttles are tuned apart — and because the sound path must
 * never be blocked by a permission the notification path is waiting on.
 *
 * Delivery itself lives in `notification.ts`, which owns the desktop/browser
 * split and the permission model.
 */

import {
  deliverSystemNotification,
  getNotificationPermission,
} from "./notification"
import {
  getDesktopNotificationPrefs,
  type NotifyEventId,
} from "./desktop-notification-prefs"

/**
 * Per-event cooldown. Collapses a burst of the same event — several agents
 * finishing within a second of each other — into one notification.
 *
 * Longer than the sound module's 1.5s because the cost of the two failure
 * modes is not symmetric: a dropped tone is gone in 300ms, a redundant
 * notification sits in the OS notification centre until the user clears it by
 * hand. Nothing is lost when one is dropped — every event still lands in the
 * UI; only the OS-level nudge is skipped, and the nudge that DID fire already
 * pulled the user back to the window where the rest are visible.
 */
const PER_EVENT_COOLDOWN_MS = 3000

/**
 * Floor between any two notifications regardless of event. Keeps back-to-back
 * events (a failing turn emits `error` and then `turn_complete`) from stacking
 * two banners. First one wins.
 */
const GLOBAL_MIN_GAP_MS = 400

export interface NotifyPayload {
  title: string
  /** Body shown when the user has not asked for contents to be hidden. */
  body: string
  /**
   * Body used instead when "hide notification contents" is on.
   *
   * Supply this whenever `body` can carry agent output or user-authored text:
   * an OS notification centre persists its payload outside the app, past the
   * point where closing the conversation would have disposed of it. Omit it
   * only when `body` is a fixed localized string that names nothing.
   */
  redactedBody?: string
}

// ── Gating ──

const lastNotifiedAt = new Map<NotifyEventId, number>()
let lastAnyNotifiedAt = 0
let suppressDepth = 0

/**
 * Run `fn` with notifications muted. Used for snapshot replay: catching up on
 * a gap after a reconnect re-delivers events that already happened, and
 * history must not raise banners for turns that finished ten minutes ago.
 */
export function withDesktopNotificationsSuppressed<T>(fn: () => T): T {
  suppressDepth += 1
  try {
    return fn()
  } finally {
    suppressDepth -= 1
  }
}

/** Whether the window is focused; `true` when the platform can't tell us. */
function windowFocused(): boolean {
  if (typeof document === "undefined") return true
  return typeof document.hasFocus === "function" ? document.hasFocus() : true
}

/** Whether the current window state satisfies the user's delivery gate. */
function windowStateAllows(when: "always" | "unfocused" | "hidden"): boolean {
  // No document means no window to interrupt (and, in the static export's
  // build pass, no platform to deliver through) — that includes `always`.
  if (typeof document === "undefined") return false
  if (when === "always") return true
  if (when === "hidden") return document.hidden === true
  // `unfocused`: covers the case `hidden` cannot — a desktop window sitting
  // fully visible on a second monitor while the user works in another app is
  // not hidden, and under the old hard-coded `document.hidden` gate it never
  // produced a single notification.
  return !windowFocused()
}

/**
 * Deliver the OS notification configured for `eventId`, if the preferences and
 * the window state allow it.
 *
 * Fire-and-forget: failures are swallowed, because there is no useful recovery
 * on an event path and every call site would otherwise carry the same empty
 * `.catch`. A user who wants to know whether delivery works has the test button
 * in Settings, which calls `sendTestNotification` and reports the real error.
 *
 * Resolves to whether a notification was actually handed to the platform.
 */
export async function notifyDesktop(
  eventId: NotifyEventId,
  payload: NotifyPayload
): Promise<boolean> {
  if (suppressDepth > 0) return false

  // Memoized in the prefs module and invalidated on write, so this stays a map
  // lookup on the hot ACP event path rather than a JSON parse per event.
  const prefs = getDesktopNotificationPrefs()
  if (!prefs.enabled) return false
  if (!prefs.events[eventId]) return false
  if (!windowStateAllows(prefs.when)) return false

  // A browser that will not deliver should not consume the cooldown: the next
  // event, after the user grants permission, must still be able to fire.
  const permission = getNotificationPermission()
  if (permission === "denied" || permission === "unsupported") return false
  if (permission === "default") return false

  const now = Date.now()
  const last = lastNotifiedAt.get(eventId)
  if (last !== undefined && now - last < PER_EVENT_COOLDOWN_MS) return false
  if (now - lastAnyNotifiedAt < GLOBAL_MIN_GAP_MS) return false

  const body =
    prefs.hideBody && payload.redactedBody !== undefined
      ? payload.redactedBody
      : payload.body

  // Claim the cooldown before awaiting. Delivery crosses an IPC boundary, and
  // two events arriving in the same tick would both pass the check above if the
  // stamp only landed after the round trip.
  lastNotifiedAt.set(eventId, now)
  lastAnyNotifiedAt = now

  try {
    await deliverSystemNotification(payload.title, body)
    return true
  } catch {
    return false
  }
}

/**
 * Post a notification on the user's explicit request, bypassing every
 * preference gate — the event switches, the window-state rule and the
 * cooldowns all describe when the app may interrupt on its own, and none of
 * them apply to a button the user just pressed.
 *
 * Throws the platform's real error, which is the entire point: on desktop
 * there is no permission to query, so a successful test send is the only
 * evidence a user can get that notifications work at all.
 */
export async function sendTestNotification(
  title: string,
  body: string
): Promise<void> {
  await deliverSystemNotification(title, body)
}

/** Test seam: drop the cooldown history and any suppression depth. */
export function resetDesktopNotificationStateForTests(): void {
  lastNotifiedAt.clear()
  lastAnyNotifiedAt = 0
  suppressDepth = 0
}
