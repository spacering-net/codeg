"use client"

/**
 * Tells codeg whether the owner is here (6.2, 1.12): every window beats —
 * whether it has the focus, and how long since the last key or pointer
 * input in it. Input counts only while the window has the focus; a window
 * in the background is never "in use". Coming to the window — it gets the
 * focus, it opens with it, its tab is shown — is itself the owner at it.
 * A beat goes out at once on focus,
 * blur and visibility changes, at once on the first input after a while
 * without one, and every 30 s while the window has the focus. The backend
 * decides from that whether the owner is present, and (with their record
 * on) learns their usual hours.
 *
 * More rides along (1.13): how long since the owner last typed into
 * something editable here (a composer, an editor, a terminal) — typing is
 * focus, and normal news waits for them to stop — the assistant whose
 * conversation this window is showing them, which is not notified, and the
 * session its workspace has in front (6.7), which gets no "waiting" card.
 * A change of either goes out at once (typing: the first after a while).
 *
 * Some windows are not the owner at work — the login page, the desktop pet,
 * the computer-use overlays — and never beat. A failed beat is dropped
 * silently: the next one says the same.
 */

import { useEffect } from "react"

import { personalAgentPresence } from "@/lib/api"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"
import { useTabStore } from "@/stores/tab-store"
import { useWorkbenchRouteStore } from "@/stores/workbench-route-store"

/** How often a window with the focus beats. */
export const BEAT_EVERY_MS = 30_000
/** Input after this long without a beat that carried it is sent at once. */
export const FRESH_AFTER_MS = 60_000
/** Pointer moves are counted at most this often. */
const MOVE_EVERY_MS = 1_000

const SKIPPED = ["/login", "/pet", "/computer-indicator", "/computer-marker"]

/** Whether a window on `pathname` stays out of presence. */
export function skipsPresence(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/"
  return SKIPPED.some((p) => path === p || path.startsWith(`${p}/`))
}

function newWindowId(): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return crypto.randomUUID()
    }
  } catch {
    // fall through
  }
  return `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

const INPUTS = [
  "keydown",
  "pointerdown",
  "pointermove",
  "wheel",
  "touchstart",
] as const

/** The `<input>` types that take text. */
const TEXT_INPUTS = new Set([
  "",
  "text",
  "search",
  "email",
  "url",
  "tel",
  "password",
  "number",
])

/** Whether a key pressed on `target` is typing: into a text field, a text
 *  area (the composers, Monaco, xterm's hidden one) or editable content. */
export function isTyping(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) {
    return false
  }
  if (target.isContentEditable) return true
  if (target instanceof HTMLTextAreaElement) return !target.readOnly
  if (target instanceof HTMLInputElement) {
    return !target.readOnly && TEXT_INPUTS.has(target.type.toLowerCase())
  }
  return false
}

/** The session (conversation) this window's workspace has in front — only
 *  while the conversations are what it shows, not Today, the board or
 *  another page over them: a session waiting on the owner while they are in
 *  it gets no card (6.7). */
export function conversationInFront(): number | null {
  if (useWorkbenchRouteStore.getState().route !== "conversations") return null
  const { tabs, activeTabId } = useTabStore.getState()
  if (activeTabId == null) return null
  return tabs.find((t) => t.id === activeTabId)?.conversationId ?? null
}

/** Start beating for this window; returns the stop. */
export function startPresenceHeartbeat(): () => void {
  const id = newWindowId()
  let lastInput: number | null = null
  /** The input the last beat carried. */
  let sentInput: number | null = null
  let lastTyped: number | null = null
  /** The typing the last beat carried. */
  let sentTyped: number | null = null
  let lastMove = 0
  let stopped = false

  const focused = () =>
    document.visibilityState !== "hidden" && document.hasFocus()

  const beat = (hasFocus = focused()) => {
    if (stopped || skipsPresence(window.location.pathname)) return
    const now = Date.now()
    const idleMs = lastInput == null ? null : Math.max(0, now - lastInput)
    const typedMs = lastTyped == null ? null : Math.max(0, now - lastTyped)
    const viewing = usePersonalAgentUi.getState().viewing
    const inFront = conversationInFront()
    sentInput = lastInput
    sentTyped = lastTyped
    Promise.resolve()
      .then(() =>
        personalAgentPresence(id, hasFocus, idleMs, typedMs, viewing, inFront)
      )
      .catch(() => {})
  }

  const onInput = (e: Event) => {
    if (!document.hasFocus()) return
    const now = Date.now()
    if (e.type === "pointermove") {
      if (now - lastMove < MOVE_EVERY_MS) return
      lastMove = now
    }
    lastInput = now
    let fresh = sentInput == null || now - sentInput > FRESH_AFTER_MS
    if (e.type === "keydown" && isTyping(e.target)) {
      lastTyped = now
      if (sentTyped == null || now - sentTyped > FRESH_AFTER_MS) fresh = true
    }
    if (fresh) beat(true)
  }
  /** The owner came to this window: that is input too. */
  const arrived = () => {
    lastInput = Date.now()
  }
  const onFocus = () => {
    arrived()
    beat(true)
  }
  const onBlur = () => beat(false)
  const onVisibility = () => {
    if (focused()) arrived()
    beat()
  }
  const onHide = () => beat(false)

  const opts: AddEventListenerOptions = { capture: true, passive: true }
  for (const type of INPUTS) window.addEventListener(type, onInput, opts)
  window.addEventListener("focus", onFocus)
  window.addEventListener("blur", onBlur)
  window.addEventListener("pagehide", onHide)
  document.addEventListener("visibilitychange", onVisibility)
  const timer = window.setInterval(() => {
    if (focused()) beat(true)
  }, BEAT_EVERY_MS)
  // The assistant shown here changed: say so at once.
  const offViewing = usePersonalAgentUi.subscribe((s, prev) => {
    if (s.viewing !== prev.viewing) beat()
  })
  // So did the session in front (6.7): another tab, or another page over
  // the conversations.
  let lastInFront = conversationInFront()
  const inFrontChanged = () => {
    const now = conversationInFront()
    if (now !== lastInFront) {
      lastInFront = now
      beat()
    }
  }
  const offTabs = useTabStore.subscribe(inFrontChanged)
  const offRoute = useWorkbenchRouteStore.subscribe(inFrontChanged)
  if (focused()) arrived()
  beat()

  return () => {
    stopped = true
    offViewing()
    offTabs()
    offRoute()
    window.clearInterval(timer)
    for (const type of INPUTS) window.removeEventListener(type, onInput, opts)
    window.removeEventListener("focus", onFocus)
    window.removeEventListener("blur", onBlur)
    window.removeEventListener("pagehide", onHide)
    document.removeEventListener("visibilitychange", onVisibility)
  }
}

export function PresenceHeartbeat() {
  useEffect(() => startPresenceHeartbeat(), [])
  return null
}
