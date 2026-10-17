"use client"

/**
 * Taskbar / Dock attention for agent events — the gate every call site goes
 * through, next to its `notifyDesktop` call.
 *
 * Asks the OS to point the user back at THIS window: macOS bounces the Dock
 * icon, Windows flashes the window's taskbar button, Linux sets the window's
 * urgency hint. One call through Tauri's own window API
 * (`requestUserAttention`), so each workspace window — including a
 * remote-workspace one, whose transport points at another machine — flashes
 * its own entry on the screen in front of the user.
 *
 * Kept apart from `desktop-notification.ts` for the reason that module keeps
 * itself apart from the sound one: the gates differ. A notification can wait
 * for the window to be hidden; a taskbar flash is pointless while the user is
 * looking at the window and useful exactly when they are not, so the only
 * window-state rule here is "not focused". And neither path may be blocked by
 * the other's switches — someone who turned banners off can still want the
 * taskbar to blink.
 */

import type { Window as TauriWindow } from "@tauri-apps/api/window"

import { detectPlatform } from "@/hooks/use-platform"

import { isDesktop } from "./transport"
import {
  getWindowAttentionPrefs,
  type AttentionEventId,
  type AttentionLevel,
} from "./window-attention-prefs"

/**
 * Per-event cooldown. Collapses a burst of the same event (several sessions
 * finishing at once) into one request; the first one already did the job.
 */
const PER_EVENT_COOLDOWN_MS = 1500

/**
 * Floor between two requests that would not raise the level. A failing turn
 * reports `error` and then finishes, and the second request would only repeat
 * the first. A STRONGER request is never held back by it: a permission prompt
 * landing right after another session finished must still turn a single
 * bounce into one that lasts.
 */
const GLOBAL_MIN_GAP_MS = 400

type RequestLevel = Exclude<AttentionLevel, "off">

const LEVEL_RANK: Record<RequestLevel, number> = {
  informational: 1,
  critical: 2,
}

const lastRequestedAt = new Map<AttentionEventId, number>()
let lastAnyRequestedAt = 0
let lastAnyLevel: RequestLevel | null = null
let suppressDepth = 0

/**
 * Whether the native window has focus, from Tauri's focus events; `null` until
 * it is first known.
 *
 * Tracked on top of `document.hasFocus()` because the two disagree in one real
 * case: a built-in browser tab is a child webview, so while the user is typing
 * into it the window is focused but this document is not. Asking for attention
 * then would mark the very window they are using.
 */
let nativeFocused: boolean | null = null
/** Native focus events seen so far; orders them against the initial read. */
let focusEventCount = 0
/** A request went out and the window has not been focused since. */
let raisedSinceFocus = false
/** A lasting (`critical`) request went out and the window has not been focused since. */
let lastingSinceFocus = false
let focusTracking: Promise<void> | null = null

/**
 * Run `fn` with attention requests muted. Used for snapshot replay: catching up
 * on a gap re-delivers events that already happened, and history must not
 * flash the taskbar for a turn that finished ten minutes ago.
 */
export function withWindowAttentionSuppressed<T>(fn: () => T): T {
  suppressDepth += 1
  try {
    return fn()
  } finally {
    suppressDepth -= 1
  }
}

function windowFocused(): boolean {
  if (nativeFocused === true) return true
  // No document means no window to flash.
  if (typeof document === "undefined") return true
  return typeof document.hasFocus === "function" ? document.hasFocus() : true
}

/**
 * `windowFocused()`, for the request path. A user found in the window has seen
 * whatever was asked for before — the platform ended it on activation — so the
 * record of a lasting request goes too, even if no focus event said so.
 */
function focusedNow(): boolean {
  if (!windowFocused()) return false
  lastingSinceFocus = false
  return true
}

/**
 * Whether a new request replaces the one already showing — true only on
 * Windows. `FlashWindowEx` takes the latest call's flags and count, so a brief
 * flash asked for after a lasting one would cut it down to four blinks while
 * the prompt it was raised for is still waiting. macOS files each Dock request
 * separately until the app is activated, and Linux has a single urgency flag,
 * so a later request takes nothing away there. macOS must not follow this rule
 * either: a lasting request made while another Codeg window is in front (the
 * pet, Settings) is a no-op, and would then hold back everything after it.
 */
function laterRequestReplacesEarlier(): boolean {
  return detectPlatform() === "windows"
}

/**
 * Start following the window's native focus, once per window, and learn where
 * it stands now.
 *
 * Coming back to the window is the moment a request has done its job. Two
 * things follow from it:
 *   - the cooldowns are spent: the next event after the user leaves again is
 *     news, not a repeat of the one that brought them back;
 *   - the request is withdrawn. On Linux that is the ONLY way the urgency hint
 *     goes away — tao sets it, nothing clears it on focus, and some taskbars
 *     keep blinking an urgent window the user is already in. macOS and Windows
 *     end the request on activation themselves, and withdrawing it there is a
 *     no-op.
 *
 * Never rejects: a window that cannot follow its focus still flashes, gated on
 * `document.hasFocus()` alone.
 */
function trackFocus(win: TauriWindow): Promise<void> {
  focusTracking ??= (async () => {
    try {
      await win.onFocusChanged(({ payload: focused }) => {
        focusEventCount += 1
        nativeFocused = focused
        if (!focused) return
        lastRequestedAt.clear()
        lastAnyRequestedAt = 0
        lastAnyLevel = null
        lastingSinceFocus = false
        if (!raisedSinceFocus) return
        raisedSinceFocus = false
        void win.requestUserAttention(null).catch(() => {})
      })
      // Both listeners are in place from here on, so every later change
      // arrives as an event. One made while they were being added may have
      // been half heard — Tauri adds the focus listener before the blur one,
      // so a focus can land and the blur right after it go missing — which is
      // why the state read now wins over anything heard so far. Only an event
      // that lands while the read is in flight beats it: that one is newer.
      const eventsBeforeRead = focusEventCount
      const focused = await win.isFocused()
      if (focusEventCount === eventsBeforeRead) nativeFocused = focused
    } catch {
      /* fall back to `document.hasFocus()` */
    }
  })()
  return focusTracking
}

/**
 * Ask the OS to draw the user back to this window for `eventId`, if the
 * preferences and the window state allow it.
 *
 * Fire-and-forget like `notifyDesktop`: there is no useful recovery on an event
 * path, so failures are swallowed. Resolves to whether a request was actually
 * handed to the platform.
 */
export async function requestWindowAttention(
  eventId: AttentionEventId
): Promise<boolean> {
  // Read synchronously, before anything awaits: replay mutes only for the
  // duration of its own synchronous loop.
  if (suppressDepth > 0) return false
  // A browser tab has no taskbar entry or Dock icon of its own to flash.
  if (!isDesktop()) return false

  // Memoized in the prefs module and invalidated on write, so this stays a map
  // lookup on the hot ACP event path.
  const prefs = getWindowAttentionPrefs()
  if (!prefs.enabled) return false
  const level = prefs.levels[eventId]
  if (!level || level === "off") return false
  if (focusedNow()) return false

  let api: typeof import("@tauri-apps/api/window")
  let win: TauriWindow
  try {
    api = await import("@tauri-apps/api/window")
    win = api.getCurrentWindow()
  } catch {
    return false
  }
  // The first request in a window is what starts following its focus, so
  // look again now that the native answer is in.
  await trackFocus(win)
  if (focusedNow()) return false

  // Checked and claimed with no await in between, so two events resolving in
  // the same tick cannot both pass.
  const now = Date.now()
  const last = lastRequestedAt.get(eventId)
  if (last !== undefined && now - last < PER_EVENT_COOLDOWN_MS) return false
  if (
    lastAnyLevel !== null &&
    now - lastAnyRequestedAt < GLOBAL_MIN_GAP_MS &&
    LEVEL_RANK[level] <= LEVEL_RANK[lastAnyLevel]
  ) {
    return false
  }
  // The lasting flash is still up for whatever raised it; on Windows this
  // request would only shorten it.
  if (
    level === "informational" &&
    lastingSinceFocus &&
    laterRequestReplacesEarlier()
  ) {
    return false
  }
  lastRequestedAt.set(eventId, now)
  lastAnyRequestedAt = now
  lastAnyLevel = level
  raisedSinceFocus = true
  if (level === "critical") lastingSinceFocus = true

  try {
    await win.requestUserAttention(
      level === "critical"
        ? api.UserAttentionType.Critical
        : api.UserAttentionType.Informational
    )
    return true
  } catch {
    return false
  }
}

/** Test seam: drop the cooldowns, focus state and any suppression depth. */
export function resetWindowAttentionStateForTests(): void {
  lastRequestedAt.clear()
  lastAnyRequestedAt = 0
  lastAnyLevel = null
  suppressDepth = 0
  nativeFocused = null
  focusEventCount = 0
  raisedSinceFocus = false
  lastingSinceFocus = false
  focusTracking = null
}
