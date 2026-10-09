"use client"

import {
  useCallback,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react"

interface ContextMenuTriggerGuardProps {
  /** Record the gesture before the browser translates a long-press into `contextmenu`. */
  onPointerDownCapture: (event: ReactPointerEvent) => void
  /** Suppress the app menu for touch/pen while leaving the native menu intact. */
  onContextMenuCapture: (event: ReactMouseEvent) => void
}

/**
 * Text long-presses should belong to the platform's selection UI, not Radix's
 * app menu. The pointer type is captured on the way in because `contextmenu`
 * itself no longer says whether the gesture came from touch or mouse.
 */
export function useContextMenuPointerGuard() {
  const pointerTypeRef = useRef<string | null>(null)

  const trackPointerType = useCallback((event: ReactPointerEvent) => {
    pointerTypeRef.current = event.pointerType
  }, [])

  const suppressAppMenu = useCallback((event: ReactMouseEvent) => {
    if (pointerTypeRef.current && pointerTypeRef.current !== "mouse") {
      event.stopPropagation()
    }
  }, [])

  const triggerProps: ContextMenuTriggerGuardProps = {
    onPointerDownCapture: trackPointerType,
    onContextMenuCapture: suppressAppMenu,
  }

  return { triggerProps }
}
