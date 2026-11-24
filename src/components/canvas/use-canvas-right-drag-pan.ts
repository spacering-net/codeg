"use client"

import { useEffect, type RefObject } from "react"
import { useReactFlow } from "@xyflow/react"

/**
 * Right-drag (and middle-drag) panning that works over EVERY element on the
 * canvas — cards, regions, notes, and the transcript inside an expanded
 * conversation.
 *
 * ReactFlow cannot do this. Its `NodeWrapper` stamps the `nopan` class onto
 * every draggable node, and d3-zoom's filter bails out the moment the event
 * originates inside a `nopan` subtree — so `panOnDrag={[2]}` pans on empty
 * canvas and nowhere else, no matter which button is configured. The flow is
 * therefore mounted with `panOnDrag={[]}` (no d3-zoom mouse panning at all) and
 * this hook owns the gesture end to end, which also keeps the feel identical
 * wherever the drag starts.
 *
 * `mousedown` rather than `pointerdown`: d3-zoom listens for mouse events, and
 * only a same-family listener can `stopPropagation` ahead of it.
 */

/** Chrome that owns its own right-click/drag behaviour and must not pan. */
const PAN_EXEMPT_SELECTOR = ".react-flow__panel, .react-flow__minimap"

/** Buttons that pan: right (2) and middle (1). Left stays selection/drag. */
function isPanButton(button: number): boolean {
  return button === 1 || button === 2
}

export function useCanvasRightDragPan(
  surfaceRef: RefObject<HTMLElement | null>
): void {
  const { getViewport, setViewport } = useReactFlow()

  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return

    let origin: {
      clientX: number
      clientY: number
      x: number
      y: number
      zoom: number
    } | null = null

    const stop = () => {
      if (!origin) return
      origin = null
      surface.removeAttribute("data-canvas-panning")
      window.removeEventListener("mousemove", onMouseMove, true)
      window.removeEventListener("mouseup", onMouseUp, true)
      window.removeEventListener("blur", stop)
    }

    /** Right (2) and middle (4) in the `buttons` BITMASK — a different encoding
     *  from `button`, which numbers them 2 and 1. */
    const PAN_BUTTONS_MASK = 6

    const onMouseMove = (e: MouseEvent) => {
      if (!origin) return
      // Nobody is holding the button any more: it was released somewhere this
      // window never heard about — over another application, or after the drag
      // left the window entirely. Without this the gesture would still be
      // running, and the next idle mouse movement over the canvas would drag
      // the whole board around under a cursor stuck on `grabbing`.
      if ((e.buttons & PAN_BUTTONS_MASK) === 0) {
        stop()
        return
      }
      setViewport({
        x: origin.x + (e.clientX - origin.clientX),
        y: origin.y + (e.clientY - origin.clientY),
        zoom: origin.zoom,
      })
    }

    const onMouseUp = (e: MouseEvent) => {
      if (!origin || !isPanButton(e.button)) return
      stop()
    }

    const onMouseDown = (e: MouseEvent) => {
      if (!isPanButton(e.button)) return
      const target = e.target
      if (
        target instanceof Element &&
        target.closest(PAN_EXEMPT_SELECTOR) != null
      ) {
        return
      }
      const viewport = getViewport()
      origin = {
        clientX: e.clientX,
        clientY: e.clientY,
        x: viewport.x,
        y: viewport.y,
        zoom: viewport.zoom,
      }
      surface.setAttribute("data-canvas-panning", "")
      // Capture on window: the pointer routinely leaves the surface (and the
      // window) mid-pan, and the gesture has to survive that.
      window.addEventListener("mousemove", onMouseMove, true)
      window.addEventListener("mouseup", onMouseUp, true)
      // Alt-tabbing away mid-drag: the release lands in another application and
      // no `mouseup` ever arrives here.
      window.addEventListener("blur", stop)
      // Claim the gesture: without this a middle-click would auto-scroll and
      // the node under the cursor would start its own drag.
      e.preventDefault()
      e.stopPropagation()
    }

    surface.addEventListener("mousedown", onMouseDown, true)
    return () => {
      surface.removeEventListener("mousedown", onMouseDown, true)
      stop()
    }
  }, [surfaceRef, getViewport, setViewport])
}
