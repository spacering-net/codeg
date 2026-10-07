// Occlusion leases for native browser surfaces.
//
// A child webview is a native view: it paints above every DOM element of the
// workspace window, so a dialog, command palette, context menu or drawer that
// opens over a browser tab would be hidden behind the page. Overlays therefore
// hold a lease while they are open; while any lease exists the surface hosts
// hide their webviews (handing keyboard focus back to the main webview first,
// so Esc / Tab reach the overlay) and show them again when the last lease is
// released. Coarse on purpose — any overlay hides every surface — because the
// rect-intersection refinement buys little and costs a layout read per
// overlay open.
//
// A lease can be PASSIVE: the overlay appeared on its own rather than being
// opened, a toast being the only one so far. The page still has to go — there
// is no other way for DOM to be seen over a native view — but a notice may
// not take the keyboard, may not leave a blank pane where a page was, and
// must give the page back the moment the user reaches for it
// (`requestNativeSurfaceReclaim`). The hosts read that off
// `isNativeSurfaceOcclusionPassive`: one real overlay in the set and the
// whole hide is an overlay's again.
//
// Zero cost when no browser tab is showing: the store has no subscribers and
// acquire/release is a counter bump.

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react"

const holders = new Map<string, number>()
const listeners = new Set<() => void>()
let count = 0
let passiveCount = 0

function notify(): void {
  for (const listener of [...listeners]) listener()
}

/** The two booleans a subscriber can see, so a change in either is published
 *  — a dialog opening over a toast changes no count a host reads directly. */
function flags(): [boolean, boolean] {
  return [isNativeSurfaceOccluded(), isNativeSurfaceOcclusionPassive()]
}

function notifyIfChanged(before: [boolean, boolean]): void {
  const after = flags()
  if (before[0] !== after[0] || before[1] !== after[1]) notify()
}

export interface NativeSurfaceOcclusionOptions {
  /** An overlay the user did not open (a toast). See the note above. */
  passive?: boolean
}

/** Take a lease; the returned function releases it exactly once. */
export function acquireNativeSurfaceOcclusion(
  reason: string,
  options?: NativeSurfaceOcclusionOptions
): () => void {
  const passive = options?.passive === true
  const before = flags()
  holders.set(reason, (holders.get(reason) ?? 0) + 1)
  count += 1
  if (passive) passiveCount += 1
  notifyIfChanged(before)
  let released = false
  return () => {
    if (released) return
    released = true
    const beforeRelease = flags()
    const remaining = (holders.get(reason) ?? 1) - 1
    if (remaining <= 0) holders.delete(reason)
    else holders.set(reason, remaining)
    count = Math.max(0, count - 1)
    if (passive) passiveCount = Math.max(0, passiveCount - 1)
    notifyIfChanged(beforeRelease)
  }
}

export function isNativeSurfaceOccluded(): boolean {
  return count > 0
}

/** True while something is holding the surfaces down and every hold is a
 *  passive one — nothing the user opened is waiting on the page to go. */
export function isNativeSurfaceOcclusionPassive(): boolean {
  return count > 0 && passiveCount >= count
}

/** Diagnostic: who is holding leases right now. */
export function nativeSurfaceOcclusionHolders(): Record<string, number> {
  return Object.fromEntries(holders)
}

export function subscribeNativeSurfaceOcclusion(
  listener: () => void
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getServerSnapshot(): boolean {
  return false
}

/** True while any overlay holds a lease. */
export function useNativeSurfaceOccluded(): boolean {
  return useSyncExternalStore(
    subscribeNativeSurfaceOcclusion,
    isNativeSurfaceOccluded,
    getServerSnapshot
  )
}

/** True while the only thing holding the surfaces down is a notice. Read
 *  alongside `useNativeSurfaceOccluded` rather than folded into one object:
 *  two booleans keep `useSyncExternalStore` honest without a cached
 *  snapshot to keep in step. */
export function useNativeSurfaceOcclusionPassive(): boolean {
  return useSyncExternalStore(
    subscribeNativeSurfaceOcclusion,
    isNativeSurfaceOcclusionPassive,
    getServerSnapshot
  )
}

// ---------------------------------------------------------------------------
// Reclaim: the user reached for a page a notice is holding down.
//
// The surface hosts raise it (a press or a scroll lands on the placeholder
// only while the native view is hidden, so it can mean nothing else); whoever
// holds the passive lease answers it by taking its notice away, which
// releases the lease and brings the page back. The store only carries the
// signal, so neither side has to know about the other.

const reclaimListeners = new Set<() => void>()

export function subscribeNativeSurfaceReclaim(
  listener: () => void
): () => void {
  reclaimListeners.add(listener)
  return () => {
    reclaimListeners.delete(listener)
  }
}

/** Ask whatever is passively holding the surfaces down to let go. */
export function requestNativeSurfaceReclaim(): void {
  for (const listener of [...reclaimListeners]) listener()
}

/**
 * For components that exist ONLY while their overlay is open: hold a lease
 * for as long as the component is mounted and `active` is true.
 *
 * Not for the shared `*Content` wrappers: React keeps those function
 * components mounted whenever their parent renders them, open or not — only
 * the primitive inside unmounts its DOM on close. Those use
 * `useNativeSurfaceOcclusionRef` and bind the lease to the DOM node instead.
 */
export function useNativeSurfaceOcclusion(reason: string, active = true): void {
  useEffect(() => {
    if (!active) return
    return acquireNativeSurfaceOcclusion(reason)
  }, [reason, active])
}

/**
 * A callback ref that holds a lease exactly while the element it is attached
 * to is in the DOM — i.e. while the overlay is actually open (Radix and Base
 * UI unmount closed content, keeping it only through the exit animation).
 * Compose it with the wrapper's own ref; it returns nothing, so React calls
 * it again with `null` on detach.
 */
export function useNativeSurfaceOcclusionRef(
  reason: string,
  active = true
): (node: Element | null) => void {
  const releaseRef = useRef<(() => void) | null>(null)
  // Release on unmount too, in case the element is never detached explicitly.
  useEffect(
    () => () => {
      releaseRef.current?.()
      releaseRef.current = null
    },
    []
  )
  return useCallback(
    (node: Element | null) => {
      if (node && active) {
        if (!releaseRef.current) {
          releaseRef.current = acquireNativeSurfaceOcclusion(reason)
        }
      } else {
        releaseRef.current?.()
        releaseRef.current = null
      }
    },
    [reason, active]
  )
}

/** Acquire a lease imperatively for the lifetime of a DOM node managed by a
 *  callback ref that returns its own cleanup (React 19 style). */
export function acquireNativeSurfaceOcclusionFor(
  reason: string,
  active: boolean
): () => void {
  if (!active) return () => {}
  return acquireNativeSurfaceOcclusion(reason)
}

export function resetNativeSurfaceOcclusionForTests(): void {
  holders.clear()
  listeners.clear()
  reclaimListeners.clear()
  count = 0
  passiveCount = 0
}

// ---------------------------------------------------------------------------
// Fallback detector for overlays that do not hold a lease (third-party
// portals, components that predate the lease). Watches the document for open
// dialog / menu roles. Only consulted when no lease is held, and only
// observing while some surface host is mounted.

const FALLBACK_SELECTOR =
  '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"]'

const fallbackListeners = new Set<() => void>()
let fallbackObserver: MutationObserver | null = null
let fallbackOpen = false

function evaluateFallback(): void {
  const next =
    typeof document !== "undefined" &&
    document.querySelector(FALLBACK_SELECTOR) !== null
  if (next === fallbackOpen) return
  fallbackOpen = next
  for (const listener of [...fallbackListeners]) listener()
}

function subscribeFallback(listener: () => void): () => void {
  fallbackListeners.add(listener)
  if (
    !fallbackObserver &&
    typeof MutationObserver !== "undefined" &&
    typeof document !== "undefined"
  ) {
    fallbackObserver = new MutationObserver(evaluateFallback)
    fallbackObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-state"],
    })
    evaluateFallback()
  }
  return () => {
    fallbackListeners.delete(listener)
    if (fallbackListeners.size === 0 && fallbackObserver) {
      fallbackObserver.disconnect()
      fallbackObserver = null
      fallbackOpen = false
    }
  }
}

/** True while an open dialog / menu is in the document (lease-less path). */
export function useFallbackOverlayOpen(): boolean {
  return useSyncExternalStore(
    subscribeFallback,
    () => fallbackOpen,
    getServerSnapshot
  )
}

// Dev-only introspection for the puppet / devtools console.
if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
  ;(window as unknown as Record<string, unknown>).__codegOcclusionDebug =
    () => ({
      count,
      passiveCount,
      holders: nativeSurfaceOcclusionHolders(),
      fallbackOpen,
    })
}
