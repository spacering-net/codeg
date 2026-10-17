"use client"

/**
 * The right sidebar's (aux panel's) tabs — Session Details, Files, Changes,
 * Commits — and the order the user dragged them into on the panel's vertical
 * tab rail.
 *
 * Kept in localStorage next to the panel's own open/width state
 * (`workspace:right-sidebar`): it only shapes this device's UI and nothing on
 * the backend reads it. Like `mention-panel-prefs.ts`, every window keeps one
 * parsed copy and refreshes it from the native `storage` event, so a reorder
 * made in one workspace window shows up in every other one at once instead of
 * being undone by the next window to write.
 */

import { useSyncExternalStore } from "react"

const ORDER_KEY = "workspace:right-sidebar-tab-order"

/** Every aux-panel tab, in the built-in order. */
export const AUX_PANEL_TABS = [
  "session_details",
  "file_tree",
  "changes",
  "git_log",
] as const

export type AuxPanelTab = (typeof AUX_PANEL_TABS)[number]

/** Every tab exactly once, top to bottom. */
export type AuxTabOrder = readonly AuxPanelTab[]

export const DEFAULT_AUX_TAB_ORDER: AuxTabOrder = AUX_PANEL_TABS

export function isAuxPanelTab(value: unknown): value is AuxPanelTab {
  return (
    typeof value === "string" &&
    (AUX_PANEL_TABS as readonly string[]).includes(value)
  )
}

/**
 * Coerce a stored (or about-to-be-stored) value into a full permutation of
 * {@link AUX_PANEL_TABS}, whatever came in:
 *
 * - anything but an array reads as the built-in order;
 * - unknown entries and repeats are dropped (first occurrence wins);
 * - a tab the value doesn't list (one added after it was written) goes right
 *   after the nearest tab before it in the built-in order that the value does
 *   list, or first when there is none — so a new tab lands beside its
 *   neighbour instead of going missing from the rail.
 */
export function parseAuxTabOrder(raw: unknown): AuxTabOrder {
  if (!Array.isArray(raw)) return DEFAULT_AUX_TAB_ORDER
  const seen = new Set<AuxPanelTab>()
  const order: AuxPanelTab[] = []
  for (const entry of raw) {
    if (!isAuxPanelTab(entry) || seen.has(entry)) continue
    seen.add(entry)
    order.push(entry)
  }
  // In built-in order, so a tab added here is a neighbour the next one finds.
  AUX_PANEL_TABS.forEach((tab, index) => {
    if (seen.has(tab)) return
    let at = 0
    for (let before = index - 1; before >= 0; before--) {
      const found = order.indexOf(AUX_PANEL_TABS[before])
      if (found >= 0) {
        at = found + 1
        break
      }
    }
    order.splice(at, 0, tab)
    seen.add(tab)
  })
  return order
}

/** Same tabs in the same order. */
export function sameAuxTabOrder(a: AuxTabOrder, b: AuxTabOrder): boolean {
  return a.length === b.length && a.every((tab, index) => tab === b[index])
}

/**
 * Move `tab` by `delta` slots (negative = up). A move that would fall off
 * either end — or names a tab that isn't in the order — returns the SAME array,
 * so a clamped nudge neither re-renders the rail nor rewrites storage.
 */
export function moveAuxTab(
  order: AuxTabOrder,
  tab: AuxPanelTab,
  delta: number
): AuxTabOrder {
  const from = order.indexOf(tab)
  if (from < 0) return order
  const to = from + delta
  if (to < 0 || to >= order.length || to === from) return order
  const next = order.slice()
  next.splice(from, 1)
  next.splice(to, 0, tab)
  return next
}

/**
 * The stored order, or `undefined` when storage can't be read at all — which
 * is not the same as nothing stored, and must not read as the built-in order.
 * A value that is there but damaged does read as the built-in order.
 */
function readStoredOrder(): AuxTabOrder | undefined {
  let raw: string | null
  try {
    raw = localStorage.getItem(ORDER_KEY)
  } catch {
    return undefined
  }
  let parsed: unknown = null
  if (raw) {
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = null
    }
  }
  return parseAuxTabOrder(parsed)
}

export function loadAuxTabOrder(): AuxTabOrder {
  if (typeof window === "undefined") return DEFAULT_AUX_TAB_ORDER
  return readStoredOrder() ?? DEFAULT_AUX_TAB_ORDER
}

// ── Shared snapshot ──
//
// One parsed copy per window, refreshed by a write here or in another window.
// Its identity changes only when the order does: the `storage` event also fires
// for every other key another window writes (drafts are saved as you type), and
// a fresh array per event would re-render the rail for nothing.

let snapshot: AuxTabOrder | null = null
const listeners = new Set<() => void>()
let windowBound = false

function publish(next: AuxTabOrder): void {
  if (snapshot && sameAuxTabOrder(snapshot, next)) return
  snapshot = next
  for (const listener of listeners) listener()
}

function refresh(): void {
  // Read the store as it is now rather than trusting the event's `newValue`:
  // `storage` events are queued, so one can describe a write that a later one
  // has already replaced.
  const next = readStoredOrder()
  // Unreadable: keep what this window shows rather than resetting it.
  if (next === undefined) return
  publish(next)
}

function bindWindow(): void {
  if (windowBound || typeof window === "undefined") return
  windowBound = true
  window.addEventListener("storage", (event) => {
    // `key === null` is a wholesale `localStorage.clear()` elsewhere.
    if (event.key !== null && event.key !== ORDER_KEY) return
    refresh()
  })
}

/**
 * Persist `order` (normalized first, so a stored value is always well-formed)
 * and show it in this window. Dragging back to the built-in order drops the
 * stored value instead of writing it, so a later change to the built-in order
 * still reaches everyone whose rail matches it. A write storage refuses (full,
 * or disabled) still holds in this window — it is published from the value,
 * not read back from storage, which would only undo it.
 */
export function saveAuxTabOrder(order: AuxTabOrder): void {
  if (typeof window === "undefined") return
  bindWindow()
  const next = parseAuxTabOrder(order)
  try {
    if (sameAuxTabOrder(next, DEFAULT_AUX_TAB_ORDER)) {
      localStorage.removeItem(ORDER_KEY)
    } else {
      localStorage.setItem(ORDER_KEY, JSON.stringify(next))
    }
  } catch {
    /* kept in this window only, see above */
  }
  // Other windows hear the native `storage` event; it never fires in the
  // window that wrote.
  publish(next)
}

/** The current order; the identity only changes when the order does. */
export function getAuxTabOrder(): AuxTabOrder {
  // Reading is enough to start tracking changes, so a copy taken before the
  // first subscriber arrived can't go stale.
  bindWindow()
  if (typeof window === "undefined") return DEFAULT_AUX_TAB_ORDER
  snapshot ??= loadAuxTabOrder()
  return snapshot
}

/** Subscribe to order changes from this window or any other. */
export function subscribeAuxTabOrder(onChange: () => void): () => void {
  bindWindow()
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

/**
 * Stable pre-hydration value. The exported HTML is built without a browser, so
 * the first pass renders the built-in order and the stored one swaps in once
 * hydrated.
 */
function getServerAuxTabOrder(): AuxTabOrder {
  return DEFAULT_AUX_TAB_ORDER
}

/** Reactive read of the tab order; live across windows. */
export function useAuxTabOrder(): AuxTabOrder {
  return useSyncExternalStore(
    subscribeAuxTabOrder,
    getAuxTabOrder,
    getServerAuxTabOrder
  )
}

/** Test seam: forget the parsed copy so the next read hits storage. */
export function resetAuxTabOrderCacheForTests(): void {
  snapshot = null
}
