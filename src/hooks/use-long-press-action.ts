"use client"

import { useCallback, useEffect, useRef } from "react"
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react"

interface UseLongPressActionOptions {
  /**
   * Called for a click that is NOT the tail of a long press — a quick tap or
   * a fast mouse click. (Radix keyboard activation reaches items via
   * `onSelect`, never as a click, so it bypasses this hook entirely.)
   */
  onPress?: (event: ReactMouseEvent<HTMLElement>) => void
  /** Called once the pointer has been held still for `longPressMs`. */
  onLongPress: (event: ReactPointerEvent<HTMLElement>) => void
  /** Hold duration before `onLongPress` fires. */
  longPressMs?: number
  /**
   * Movement in either axis beyond this cancels the in-flight press and lets
   * the browser's own scroll take over. Mirrors the threshold used by
   * `useLongPressToOpenMenu` / `useLongPressDrag`.
   */
  moveThresholdPx?: number
}

/**
 * Pointer handlers that split one element's click into a short press and a
 * long press: a still hold of `longPressMs` fires `onLongPress` (while the
 * pointer is still down), while any click that is not the tail of such a hold
 * goes to `onPress`. Unlike `useLongPressToOpenMenu` / `useLongPressDrag`,
 * mouse presses participate too — there is no native desktop equivalent for
 * this gesture.
 *
 * Spread the returned `handlers` onto the element (typically a Radix
 * `DropdownMenuItem`). The trailing click that the browser synthesizes after
 * a long press is detected and swallowed — including its `preventDefault`,
 * so Radix's own select-on-click (which composes after the item's onClick)
 * stays out of the way. A long press whose element unmounted before the
 * click could arrive leaves the suppression stale; advancing an interaction
 * id on every pointerdown, the same way `useLongPressDrag` does, keeps it
 * from eating a later genuine tap.
 *
 * `onContextMenu` always default-prevents: a touch hold would otherwise pop
 * the browser's native context menu / selection callout over the custom
 * gesture, and right-click has no meaning on a menu row.
 */
export function useLongPressAction({
  onPress,
  onLongPress,
  longPressMs = 500,
  moveThresholdPx = 10,
}: UseLongPressActionOptions) {
  const timerRef = useRef<number | null>(null)
  const startRef = useRef<{ x: number; y: number } | null>(null)
  const interactionIdRef = useRef(0)
  const suppressedInteractionRef = useRef<number | null>(null)
  // Latest callbacks, so a timer armed from a pointerdown fires the current
  // closures even if the caller re-created them while the pointer was still
  // down (its state may have moved on during the hold). Synced via useEffect
  // — React flushes pending effects before dispatching the next event, so
  // the refs are current by the time any handler reads them.
  const onPressRef = useRef(onPress)
  const onLongPressRef = useRef(onLongPress)
  useEffect(() => {
    onPressRef.current = onPress
  }, [onPress])
  useEffect(() => {
    onLongPressRef.current = onLongPress
  }, [onLongPress])

  const clear = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    startRef.current = null
  }, [])

  useEffect(
    () => () => {
      clear()
    },
    [clear]
  )

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      // Only the primary button starts a press — right/middle clicks and the
      // pen barrel button carry their own semantics.
      if (event.button !== 0) return
      const interactionId = ++interactionIdRef.current
      clear()
      // Capture the coordinates now — `event.currentTarget` is nulled out by
      // React after the handler returns, and the hold may outlive the event.
      startRef.current = { x: event.clientX, y: event.clientY }
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        suppressedInteractionRef.current = interactionId
        onLongPressRef.current(event)
      }, longPressMs)
    },
    [clear, longPressMs]
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const start = startRef.current
      if (!start) return
      const dx = Math.abs(event.clientX - start.x)
      const dy = Math.abs(event.clientY - start.y)
      if (dx > moveThresholdPx || dy > moveThresholdPx) clear()
    },
    [clear, moveThresholdPx]
  )

  const onPointerUp = useCallback(() => {
    clear()
  }, [clear])

  const onPointerCancel = useCallback(() => {
    clear()
  }, [clear])

  const onClick = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (suppressedInteractionRef.current === interactionIdRef.current) {
      suppressedInteractionRef.current = null
      event.preventDefault()
      return
    }
    onPressRef.current?.(event)
  }, [])

  const onContextMenu = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault()
  }, [])

  return {
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onClick,
      onContextMenu,
    },
  }
}
