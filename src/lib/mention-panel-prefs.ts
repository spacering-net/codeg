"use client"

/**
 * Which tabs the composer's `@` mention panel shows, and in what order.
 *
 * Kept in localStorage like the other look-and-feel preferences (keyboard
 * shortcuts, the chat column width): it only shapes this device's UI and
 * nothing on the backend reads it. Same reactive plumbing as
 * `notification-sound-prefs.ts` — a custom event for the current window plus
 * the native `storage` event for other windows/tabs — so a change made in the
 * Settings window reaches every open composer at once.
 *
 * Every `@` panel reads it (chat input, task editor, automation editor): they
 * are one affordance, so one preference.
 */

import { useMemo, useSyncExternalStore } from "react"

const PREFS_KEY = "settings:mention-panel:v1"
const PREFS_EVENT = "codeg:mention-panel-changed"

/**
 * The panel's tabs in their built-in order: agent first (a product decision —
 * handing a subtask to another agent is what `@` is there for), the user's
 * assistants beside it, then the rest. Skills, commands and experts are not
 * tabs: they come from the `/` and `$` triggers.
 */
export const MENTION_TAB_KINDS = [
  "agent",
  "assistant",
  "file",
  "session",
  "commit",
] as const

export type MentionTabKind = (typeof MENTION_TAB_KINDS)[number]

/**
 * The tab that can never be hidden. Files are what `@` referenced long before
 * the other kinds existed, and keeping one tab mandatory means the panel can
 * never be configured into an empty strip.
 */
export const PINNED_MENTION_TAB: MentionTabKind = "file"

export interface MentionTabPref {
  kind: MentionTabKind
  visible: boolean
}

export interface MentionPanelPrefs {
  /** Every tab exactly once, in display order. */
  tabs: MentionTabPref[]
}

export const DEFAULT_MENTION_PANEL_PREFS: MentionPanelPrefs = {
  tabs: MENTION_TAB_KINDS.map((kind) => ({ kind, visible: true })),
}

export function isMentionTabKind(value: unknown): value is MentionTabKind {
  return (
    typeof value === "string" &&
    (MENTION_TAB_KINDS as readonly string[]).includes(value)
  )
}

/**
 * Normalize a stored (or about-to-be-stored) value. The result always lists
 * every tab exactly once and always shows the pinned one, whatever came in:
 *
 * - entries that aren't objects, name an unknown kind, or repeat a kind are
 *   dropped (first occurrence wins);
 * - `visible` is honoured only as an explicit `false` — anything else shows the
 *   tab, so a damaged flag can't make a tab disappear;
 * - a kind the value doesn't mention (written before that tab existed) is
 *   added, shown, right after the nearest kind before it in the built-in order
 *   that the value does list — hidden or not — or first when there is none.
 *   So the old built-in list `[agent, file, session, commit]` reads as the new
 *   built-in one (and "Reset" does not light up for nothing), and a customized
 *   list gets the new tab beside its neighbour, visible to the people who
 *   customized the old list too.
 */
export function parseMentionPanelPrefs(raw: unknown): MentionPanelPrefs {
  const seen = new Set<MentionTabKind>()
  const tabs: MentionTabPref[] = []
  const stored =
    raw && typeof raw === "object"
      ? (raw as Record<string, unknown>).tabs
      : undefined
  if (Array.isArray(stored)) {
    for (const entry of stored) {
      if (!entry || typeof entry !== "object") continue
      const { kind, visible } = entry as Record<string, unknown>
      if (!isMentionTabKind(kind) || seen.has(kind)) continue
      seen.add(kind)
      tabs.push({
        kind,
        visible: kind === PINNED_MENTION_TAB || visible !== false,
      })
    }
  }
  // In built-in order, so a kind added here is a neighbour the next one finds.
  MENTION_TAB_KINDS.forEach((kind, index) => {
    if (seen.has(kind)) return
    let at = 0
    for (let before = index - 1; before >= 0; before--) {
      const found = tabs.findIndex(
        (tab) => tab.kind === MENTION_TAB_KINDS[before]
      )
      if (found >= 0) {
        at = found + 1
        break
      }
    }
    tabs.splice(at, 0, { kind, visible: true })
    seen.add(kind)
  })
  return { tabs }
}

/** Same tabs, same order, same visibility. */
export function sameMentionPanelPrefs(
  a: MentionPanelPrefs,
  b: MentionPanelPrefs
): boolean {
  return (
    a.tabs.length === b.tabs.length &&
    a.tabs.every(
      (tab, index) =>
        tab.kind === b.tabs[index].kind && tab.visible === b.tabs[index].visible
    )
  )
}

/** The kinds the panel shows, in display order. */
export function visibleMentionTabKinds(
  prefs: MentionPanelPrefs
): MentionTabKind[] {
  return prefs.tabs.filter((tab) => tab.visible).map((tab) => tab.kind)
}

export function loadMentionPanelPrefs(): MentionPanelPrefs {
  if (typeof window === "undefined") {
    return parseMentionPanelPrefs(null)
  }
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    return parseMentionPanelPrefs(raw ? JSON.parse(raw) : null)
  } catch {
    return parseMentionPanelPrefs(null)
  }
}

function notifyThisWindow(): void {
  // Other windows/tabs get the native `storage` event; it never fires in the
  // window that wrote, which may be the workspace window itself (the web build
  // can host the settings route there).
  window.dispatchEvent(new CustomEvent(PREFS_EVENT))
}

/** Persist `prefs` (normalized first, so a stored value is always well-formed). */
export function saveMentionPanelPrefs(prefs: MentionPanelPrefs): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify(parseMentionPanelPrefs(prefs))
    )
  } catch {
    /* ignore */
  }
  notifyThisWindow()
}

/**
 * Back to the built-in tabs. Drops the stored value rather than writing the
 * defaults, so a later change to the built-in order reaches anyone who never
 * customized it.
 */
export function resetMentionPanelPrefs(): void {
  if (typeof window === "undefined") return
  try {
    localStorage.removeItem(PREFS_KEY)
  } catch {
    /* ignore */
  }
  notifyThisWindow()
}

// ── Shared snapshot ──
//
// One parsed copy per window, refreshed by a write here or in another
// window/tab. Its identity changes only when the preference does: every mounted
// composer subscribes, and the `storage` event also fires for every other key
// another window writes (drafts are saved as you type), so a fresh object per
// event would re-render each of them for nothing.

let snapshot: MentionPanelPrefs | null = null
const listeners = new Set<() => void>()
let windowBound = false

function refresh(): void {
  // Read the store as it is now rather than trusting the event's `newValue`:
  // `storage` events are queued, so one can describe a write that a later one
  // has already replaced.
  const next = loadMentionPanelPrefs()
  if (snapshot && sameMentionPanelPrefs(snapshot, next)) return
  snapshot = next
  for (const listener of listeners) listener()
}

function bindWindow(): void {
  if (windowBound || typeof window === "undefined") return
  windowBound = true
  window.addEventListener(PREFS_EVENT, refresh)
  window.addEventListener("storage", (event) => {
    // `key === null` is a wholesale `localStorage.clear()` elsewhere.
    if (event.key !== null && event.key !== PREFS_KEY) return
    refresh()
  })
}

/** Current preferences; the identity only changes when the value does. */
export function getMentionPanelPrefs(): MentionPanelPrefs {
  // Reading is enough to start tracking changes, so a copy taken before the
  // first subscriber arrived can't go stale.
  bindWindow()
  if (typeof window === "undefined") return DEFAULT_MENTION_PANEL_PREFS
  snapshot ??= loadMentionPanelPrefs()
  return snapshot
}

/** Subscribe to preference changes from this window or any other. */
export function subscribeMentionPanelPrefs(onChange: () => void): () => void {
  bindWindow()
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

/**
 * Stable pre-hydration value. The exported HTML is built without a browser, so
 * the first pass renders the built-in tabs and the stored ones swap in once
 * hydrated.
 */
function getServerMentionPanelPrefs(): MentionPanelPrefs {
  return DEFAULT_MENTION_PANEL_PREFS
}

/** Reactive read of the preferences; live across windows. */
export function useMentionPanelPrefs(): MentionPanelPrefs {
  return useSyncExternalStore(
    subscribeMentionPanelPrefs,
    getMentionPanelPrefs,
    getServerMentionPanelPrefs
  )
}

/**
 * The kinds the panel shows, in display order. Referentially stable until the
 * preference changes, so it is safe as an effect dependency.
 */
export function useVisibleMentionTabs(): readonly MentionTabKind[] {
  const prefs = useMentionPanelPrefs()
  return useMemo(() => visibleMentionTabKinds(prefs), [prefs])
}

/** Test seam: forget the parsed copy so the next read hits storage. */
export function resetMentionPanelPrefsCacheForTests(): void {
  snapshot = null
}
