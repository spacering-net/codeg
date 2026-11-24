"use client"

import { useEffect, useRef } from "react"

// Key written into `history.state` for the entries this hook pushes. The value
// is the entry's DEPTH: its place in the stack of overlay entries, 1 being the
// first one above the page's own. Every push lands one above the entry it was
// made from, so depths only grow along the session history, and "is my entry
// still there?" becomes a comparison: it is gone exactly when the current
// entry sits lower. A per-push identity cannot answer that — after a back
// lands on the entry two layers down, every layer except that entry's owner
// would read "not mine" and close at once.
//
// A position also survives a reload, which keeps `history.state` but restarts
// this module: a counter would hand out ids that stale entries still carry,
// and a stale twin of a layer's id reads as that layer's own entry.
const DEPTH_KEY = "codegBackDismissDepth"

// Depths whose entry an open layer holds right now. An entry carrying a depth
// that is not in here is a leftover nobody owns.
const heldDepths = new Set<number>()

function currentDepth(): number {
  const state: unknown = window.history.state
  if (state && typeof state === "object" && DEPTH_KEY in state) {
    const value = (state as Record<string, unknown>)[DEPTH_KEY]
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      return value
    }
  }
  return 0
}

/**
 * Makes a state-toggled overlay (a panel swap, a drawer) consume one browser
 * back gesture instead of letting that back fall through the real navigation
 * and unload the page — the mobile-web/PWA case, where back is the habitual
 * "close what's on top" gesture and an empty history exits the app outright.
 *
 * While `active` is true the layer holds one history entry above the page's
 * own (URL unchanged, only `history.state` carries the marker). A traversal
 * that leaves the current entry below the layer's calls `onDismiss`, so layers
 * opened on top of each other unwind one per back, topmost first.
 *
 * Closing by any other path (close button, a tap outside, a programmatic
 * close) does NOT remove the entry: this hook never calls `history.back()`.
 * A back issued as one layer closes races the push of a layer opening in the
 * same commit (React's StrictMode dev double-mount is exactly that pair). And
 * a push that follows a back is one Chrome holds against the page: after a
 * back it stops honouring earlier taps for new entries (crbug.com/1248529),
 * so a layer opened by the same tap that closed another (a file picked in the
 * sidebar) would get an entry Chrome marks skippable, along with every other
 * entry of the page, and Android's next back would leave the app.
 *
 * So a leftover stays where it is, and the next layer to open while it is the
 * current entry takes it over instead of pushing another. A run of open/close
 * cycles therefore costs one entry, which the next back consumes with no
 * visible effect. Two layers closed together this way (the sidebar over the
 * file view, then a tap on a conversation) leave two: the top one gets reused,
 * the one beneath stays until a back consumes it — one silent back per pair.
 *
 * A layer that opens with no tap behind it (an agent auto-opening a preview)
 * still pushes. If the user's last action was a back, Chrome skips that entry
 * until the next tap, so a back in between leaves the page, as it did before
 * this hook existed.
 *
 * `onDismiss` is read through a ref, so callers can pass an inline callback.
 */
export function useHistoryBackDismiss(
  active: boolean,
  onDismiss: () => void
): void {
  const onDismissRef = useRef(onDismiss)
  useEffect(() => {
    onDismissRef.current = onDismiss
  }, [onDismiss])

  useEffect(() => {
    if (!active) return
    const top = currentDepth()
    let depth: number
    if (top > 0 && !heldDepths.has(top)) {
      // A leftover on top — this layer's own across a StrictMode remount,
      // another layer's that closed in the same commit this one opened, or
      // one an earlier close or a reload left behind. Take it over.
      depth = top
    } else {
      depth = top + 1
      const prev: unknown = window.history.state
      window.history.pushState(
        {
          ...(prev && typeof prev === "object" ? prev : {}),
          [DEPTH_KEY]: depth,
        },
        ""
      )
    }
    heldDepths.add(depth)
    let held = true
    const release = () => {
      if (!held) return
      held = false
      heldDepths.delete(depth)
    }
    const handlePopState = () => {
      if (!held) return
      // At or above this layer's entry: the traversal went elsewhere — a back
      // that closed a layer stacked above, or a forward onto an entry above.
      if (currentDepth() >= depth) return
      release()
      onDismissRef.current()
    }
    window.addEventListener("popstate", handlePopState)
    return () => {
      window.removeEventListener("popstate", handlePopState)
      release()
    }
  }, [active])
}
