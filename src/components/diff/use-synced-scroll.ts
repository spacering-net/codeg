"use client"

// Keeps the two panes of the side-by-side diff on the same offsets: dragging
// either pane's horizontal or vertical scrollbar moves the other one with it.
//
// The whole difficulty is telling a scroll the USER drove apart from the
// scroll WE wrote a moment ago. Scroll events are asynchronous, so the write
// to pane B arrives back as a scroll event on B, which naively propagates to
// A — harmless while both panes can reach the same offset, and a fight while
// they cannot: the two sides of a diff rarely have the same longest line, so
// the narrower pane clamps the write and then drags the pane the user is
// actually holding back to the clamped offset.
//
// The fix is to clamp the write to what the target can reach BEFORE issuing
// it, and remember that exact pair of offsets. The echo then matches what we
// recorded and is dropped; anything else is the user and propagates.

import { useCallback, useState } from "react"

type Side = "left" | "right"

interface ScrollOffsets {
  top: number
  left: number
}

/**
 * The part of a scroll container this module touches, declared structurally so
 * the pairing logic can be exercised without a layout engine — jsdom reports a
 * zero-sized box for every element and ignores writes to `scrollTop`.
 */
export interface ScrollPane {
  scrollTop: number
  scrollLeft: number
  scrollHeight: number
  clientHeight: number
  scrollWidth: number
  clientWidth: number
}

interface PaneState {
  element: ScrollPane | null
  /** The offsets last written to this pane, still waiting for their echo. */
  echo: ScrollOffsets | null
}

/**
 * Clamp a scroll offset to the target's reach, on whichever side of zero the
 * offset lives. An RTL scrollport reports `scrollLeft` as 0 at its right edge
 * and counts DOWN into negatives, so a plain `0..max` clamp would pin every
 * horizontal offset at 0 and the panes would only ever follow each other
 * vertically. The diff panes force `dir="ltr"` on themselves, but a scroll
 * pairing helper has no business assuming its callers did.
 */
function clampToReach(value: number, max: number): number {
  const limit = Math.max(0, max)
  return value < 0 ? Math.max(value, -limit) : Math.min(value, limit)
}

export interface ScrollSync {
  register: (side: Side, element: ScrollPane | null) => void
  handleScroll: (side: Side) => void
}

export function createScrollSync(): ScrollSync {
  const panes: Record<Side, PaneState> = {
    left: { element: null, echo: null },
    right: { element: null, echo: null },
  }

  const register = (side: Side, element: ScrollPane | null) => {
    panes[side].element = element
    // A pane that just mounted (or was torn down) owes us no echo.
    panes[side].echo = null
  }

  const handleScroll = (side: Side) => {
    const source = panes[side]
    const target = panes[side === "left" ? "right" : "left"]
    const from = source.element
    if (!from) return

    const echo = source.echo
    source.echo = null
    if (echo && echo.top === from.scrollTop && echo.left === from.scrollLeft) {
      return
    }

    const to = target.element
    if (!to) return

    const next: ScrollOffsets = {
      top: clampToReach(from.scrollTop, to.scrollHeight - to.clientHeight),
      left: clampToReach(from.scrollLeft, to.scrollWidth - to.clientWidth),
    }
    // Already there: writing would change nothing, so no echo is coming and
    // recording one would swallow the user's next scroll to this offset.
    if (to.scrollTop === next.top && to.scrollLeft === next.left) return

    target.echo = next
    to.scrollTop = next.top
    to.scrollLeft = next.left
  }

  return { register, handleScroll }
}

export interface SyncedScrollBinding {
  registerLeft: (element: HTMLElement | null) => void
  registerRight: (element: HTMLElement | null) => void
  handleLeftScroll: () => void
  handleRightScroll: () => void
}

/**
 * Stable callbacks for wiring two `ScrollArea`s together. They keep their
 * identity for the life of the component so `ScrollArea` doesn't rebind its
 * OverlayScrollbars event handlers on every render.
 */
export function useSyncedScroll(): SyncedScrollBinding {
  // Lazy `useState` rather than a ref: the pairing state must be built exactly
  // once per component, and a ref can't be initialized during render.
  const [sync] = useState(createScrollSync)

  const registerLeft = useCallback(
    (element: HTMLElement | null) => sync.register("left", element),
    [sync]
  )
  const registerRight = useCallback(
    (element: HTMLElement | null) => sync.register("right", element),
    [sync]
  )
  const handleLeftScroll = useCallback(() => sync.handleScroll("left"), [sync])
  const handleRightScroll = useCallback(
    () => sync.handleScroll("right"),
    [sync]
  )

  return { registerLeft, registerRight, handleLeftScroll, handleRightScroll }
}
