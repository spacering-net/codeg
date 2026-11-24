"use client"

import { useCallback, useRef, useState, type RefObject } from "react"
import type { PointerEvent as ReactPointerEvent } from "react"

/** A non-blank text selection touching `container`. */
function hasTextSelectionWithin(container: HTMLElement | null): boolean {
  if (!container) return false
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return false
  }
  if (!selection.toString().trim()) return false
  return selection.getRangeAt(0).intersectsNode(container)
}

/**
 * Controlled `open` state for a Radix `ContextMenu` whose trigger wraps
 * selectable text (the conversation transcript). On touch and pen, a long press
 * is how the browser selects text, but Radix opens the menu on that same
 * gesture: its own 700 ms timer, plus the native `contextmenu` Android sends.
 * Without this guard both happen at once. The text gets selected, and the
 * menu, which is modal (it disables outside pointer events and traps focus),
 * opens over it. The selection's own copy toolbar can then no longer be tapped,
 * and the handles can't be dragged.
 *
 * So an open request is dropped when the last press on the trigger was touch or
 * pen AND text inside `containerRef` is selected at that moment. The browser
 * selects before either open path fires (Chromium selects the word before it
 * dispatches `contextmenu`, and Radix's 700 ms timer runs past the platform
 * long-press delay). A long press on blank space, with nothing selected, still
 * opens the menu. Mouse right-click is untouched.
 *
 * Spread `onPointerDownCapture` onto the trigger element and pass `open` and
 * `onOpenChange` to the `ContextMenu` root.
 */
export function useTouchSelectionMenuGuard(
  containerRef: RefObject<HTMLElement | null>
) {
  const [open, setOpen] = useState(false)
  const touchPressRef = useRef(false)

  const onPointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      touchPressRef.current = event.pointerType !== "mouse"
    },
    []
  )

  const onOpenChange = useCallback(
    (next: boolean) => {
      if (
        next &&
        touchPressRef.current &&
        hasTextSelectionWithin(containerRef.current)
      ) {
        return
      }
      setOpen(next)
    },
    [containerRef]
  )

  return { open, onOpenChange, onPointerDownCapture }
}
