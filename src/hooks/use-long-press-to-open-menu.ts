"use client"

import { useCallback, useEffect, useRef } from "react"
import type { PointerEvent as ReactPointerEvent } from "react"

interface UseLongPressToOpenMenuOptions {
  /** When false the hook ignores every gesture and never opens the menu. */
  enabled?: boolean
  /** Hold duration before the synthetic contextmenu fires. */
  longPressMs?: number
  /**
   * Movement in either axis beyond this cancels the in-flight gesture.
   * Mirrors the threshold used by `useLongPressDrag` so both gestures behave
   * the same way when both hooks are attached to the same element.
   */
  moveThresholdPx?: number
}

/**
 * Pointer handlers that open a Radix `ContextMenu` from a touch / pen
 * long-press, while leaving desktop right-click to Radix's own contextmenu
 * handler.
 *
 * Spread the four handlers onto a `<ContextMenuTrigger asChild>` (or any
 * element that Radix already listens on). The pointerdown handler composes
 * with Radix's via `composeEventHandlers` — Radix's own 700ms long-press
 * timer keeps running in parallel, but it clears on any `pointermove`,
 * including the micro-moves a stationary touch can produce on mobile
 * browsers. This hook tolerates movement below `moveThresholdPx` and only
 * fires after the finger has been still for the full `longPressMs`.
 *
 * On fire, it dispatches a synthetic `MouseEvent("contextmenu", { button: 2,
 * clientX, clientY })` from the current target. The synthetic event bubbles
 * to Radix's `onContextMenu`, which opens the same menu the desktop right-
 * click does — single source of truth, no duplication. Mouse pointers are
 * ignored so desktop right-click keeps using Radix's native handler.
 *
 * NEVER spread this onto NESTED triggers (a tree row whose trigger encloses its
 * descendants' triggers, say). One pointerdown bubbles through every ancestor,
 * so each arms its own timer and each dispatches its own contextmenu from its
 * OWN element — the ancestors' menus open right after the intended one and the
 * outermost wins the screen. Radix's built-in long-press is safe there because
 * all the triggers share ONE bubbling event and the innermost `preventDefault`s
 * it; separate dispatches carry no such interlock. Use it on flat lists, or on
 * a single trigger with no trigger ancestors.
 */
export function useLongPressToOpenMenu({
  enabled = true,
  longPressMs = 500,
  moveThresholdPx = 10,
}: UseLongPressToOpenMenuOptions = {}) {
  const timerRef = useRef<number | null>(null)
  const startRef = useRef<{ x: number; y: number } | null>(null)

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
      if (!enabled) return
      // Desktop right-click has its own contextmenu event — keep Radix's
      // native handler in charge of opening the menu there.
      if (event.pointerType === "mouse") return
      clear()
      // Capture the target now — `event.currentTarget` is nulled out by React
      // after the handler returns, and we need it 500ms down the line.
      const target = event.currentTarget
      startRef.current = { x: event.clientX, y: event.clientY }
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        target.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            button: 2,
            clientX: event.clientX,
            clientY: event.clientY,
          })
        )
      }, longPressMs)
    },
    [enabled, longPressMs, clear]
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled) return
      if (event.pointerType === "mouse") return
      const start = startRef.current
      if (!start) return
      const dx = Math.abs(event.clientX - start.x)
      const dy = Math.abs(event.clientY - start.y)
      if (dx > moveThresholdPx || dy > moveThresholdPx) clear()
    },
    [enabled, moveThresholdPx, clear]
  )

  const onPointerUp = useCallback(() => {
    clear()
  }, [clear])

  const onPointerCancel = useCallback(() => {
    clear()
  }, [clear])

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
  }
}
