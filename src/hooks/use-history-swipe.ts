"use client"

import { useCallback, useEffect, useRef } from "react"
import type { PointerEvent as ReactPointerEvent } from "react"

import type { HistoryDirection } from "@/lib/composer-history"

/** Horizontal distance (px) a swipe must cover before it counts. */
export const HISTORY_SWIPE_THRESHOLD_PX = 48

/**
 * A swipe only counts when it is clearly horizontal: the vertical drift must
 * stay under half the horizontal distance, so a scroll flick that happens to
 * end up sideways never recalls a prompt.
 */
const MAX_VERTICAL_RATIO = 1.5

interface UseHistorySwipeOptions {
  /** Called once per confirmed horizontal swipe. */
  onSwipe: (direction: HistoryDirection) => void
  thresholdPx?: number
}

/**
 * Pointer handlers that turn a horizontal swipe into a prompt-history step:
 * left → older, right → newer — the list slides like a horizontal timeline,
 * dragging the past in from the left and revealing the present to the right.
 * The mobile counterpart of the editor's ArrowUp/ArrowDown at the document
 * edge.
 *
 * Spread the returned `handlers` onto the swipe area (the composer's send
 * row). A tap — anything under `thresholdPx` — never fires, so the buttons
 * living in the row keep working. A swipe fires at most once per touch: the
 * move handler triggers the moment the gesture is confirmed and locks until
 * the next pointerdown, so a long drag cannot step through the whole history.
 * Pair the element with `touch-action: pan-y` so vertical scrolling stays
 * native while the horizontal axis is claimed by the gesture.
 */
export function useHistorySwipe({
  onSwipe,
  thresholdPx = HISTORY_SWIPE_THRESHOLD_PX,
}: UseHistorySwipeOptions) {
  const startRef = useRef<{ x: number; y: number } | null>(null)
  const firedRef = useRef(false)
  // Latest callback, same pattern as useLongPressAction: a drag that started
  // before a re-render still fires the current closure.
  const onSwipeRef = useRef(onSwipe)
  useEffect(() => {
    onSwipeRef.current = onSwipe
  }, [onSwipe])

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    startRef.current = { x: event.clientX, y: event.clientY }
    firedRef.current = false
  }, [])

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const start = startRef.current
      if (!start || firedRef.current) return
      const dx = event.clientX - start.x
      const dy = event.clientY - start.y
      if (
        Math.abs(dx) < thresholdPx ||
        Math.abs(dx) <= MAX_VERTICAL_RATIO * Math.abs(dy)
      ) {
        return
      }
      firedRef.current = true
      onSwipeRef.current(dx > 0 ? "newer" : "older")
    },
    [thresholdPx]
  )

  const reset = useCallback(() => {
    startRef.current = null
  }, [])

  return {
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: reset,
      onPointerCancel: reset,
    },
  }
}
