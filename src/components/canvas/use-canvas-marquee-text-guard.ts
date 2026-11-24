"use client"

import { useEffect, type RefObject } from "react"

/**
 * Keeps a box-select from dragging a native text selection through the board.
 *
 * ReactFlow starts the marquee from the pane's own `pointerdown` and
 * deliberately does NOT `preventDefault` it in that case — `Pane`'s capture
 * handler only suppresses the default when the press landed on a CHILD
 * (`if (!eventTargetIsContainer) { stopPropagation(); preventDefault() }`).
 * The browser therefore does what it always does on a mouse-down: it drops a
 * text-selection anchor and extends the selection as the pointer moves — in
 * DOCUMENT order, which is why an expanded card's transcript highlighted even
 * when the marquee rectangle never went near it.
 *
 * `user-select: none` on the pane (see `globals.css`) refuses the anchor, but it
 * cannot be the whole fix, in three directions:
 *
 *  - A subtree that opts back IN is selectable again — the card body says
 *    `select-text` out loud, and `<input>`/`<textarea>` do it through the UA
 *    stylesheet. So the drag is hard-disabled for the whole surface while it
 *    runs, via `data-canvas-marquee` (the same shape as `data-canvas-panning`).
 *  - `user-select` does not reach an EDITING HOST at all. Engines allow
 *    selection inside editable content before they ever consult the property
 *    (WebKit's `Node::canStartSelection` answers "yes, editable" up front), so
 *    no declaration — `!important` included — keeps a sweep out of a card's
 *    composer, which is a contenteditable. That is why the press itself is now
 *    `preventDefault`ed: an anchor that never exists cannot be extended into
 *    anything, editable or not.
 *  - Refusing the anchor also refuses the side effect nobody notices until it is
 *    gone: pressing on blank space is what COLLAPSES the previous selection.
 *    Without it, a selection made inside a card stays lit no matter where the
 *    user clicks or marquees afterwards — the board looks like it is selecting
 *    text it never touched. Hence the explicit `removeAllRanges`.
 *
 * The press is matched with ReactFlow's own test for "a marquee is starting":
 * the event target IS the pane element. `.react-flow__background` is
 * `pointer-events: none`, so a press on empty board always lands there, and
 * everything else on the surface — cards, regions, the dock, the minimap — is a
 * descendant and never matches.
 */

/** Marks the surface for the duration of a pane-initiated left drag. */
const MARQUEE_ATTR = "data-canvas-marquee"

/** Left button in the `buttons` BITMASK (a different encoding from `button`,
 *  which numbers the left button 0). */
const PRIMARY_BUTTON_MASK = 1

export function useCanvasMarqueeTextGuard(
  surfaceRef: RefObject<HTMLElement | null>
): void {
  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return

    const stop = () => {
      surface.removeAttribute(MARQUEE_ATTR)
      window.removeEventListener("mousemove", onMouseMove, true)
      window.removeEventListener("mouseup", onMouseUp, true)
      window.removeEventListener("blur", stop)
      document.removeEventListener("selectionchange", onSelectionChange)
    }

    const onMouseUp = (e: MouseEvent) => {
      // Only the button that armed the guard may disarm it. Letting go of a
      // chorded right-click (the pan gesture) mid-marquee is still a `mouseup`,
      // and taking it would re-enable selection for the rest of a drag that is
      // very much still running.
      if (e.button === 0) stop()
    }

    const onMouseMove = (e: MouseEvent) => {
      // Nobody is holding the button any more: it was released somewhere this
      // window never heard about — over another application, or outside the
      // window entirely. Leaving the attribute on would make the whole board
      // permanently unselectable, so the release has to be inferred.
      if ((e.buttons & PRIMARY_BUTTON_MASK) === 0) stop()
    }

    // Belt and braces for the gesture's own duration. Suppressing the press
    // should mean no selection ever grows, but editing hosts are precisely the
    // place where engines ignore every declarative signal, and this is the one
    // symptom the user sees. Clearing re-fires this handler with an empty
    // selection, which the guard below returns on, so it cannot loop.
    const onSelectionChange = () => {
      const selection = window.getSelection()
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return
      }
      selection.removeAllRanges()
    }

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      const target = e.target
      if (
        !(target instanceof Element) ||
        !target.classList.contains("react-flow__pane")
      ) {
        return
      }
      window.getSelection()?.removeAllRanges()
      // No anchor, for anything — see the note about editing hosts above. The
      // marquee itself is unaffected: ReactFlow draws it from POINTER events,
      // which a suppressed `mousedown` default does not touch.
      e.preventDefault()
      // ...but the default this cancels also included moving focus off whatever
      // had it. Pressing blank board has to blur the composer it came from, or
      // the next thing typed goes into an input the user is no longer looking
      // at. Body is where the press would have left focus anyway, and the
      // board's own shortcuts are scoped to accept exactly that (see
      // `canvas-view`'s keydown handler).
      const active = document.activeElement
      if (
        active instanceof HTMLElement &&
        active !== document.body &&
        surface.contains(active)
      ) {
        active.blur()
      }
      surface.setAttribute(MARQUEE_ATTR, "")
      window.addEventListener("mousemove", onMouseMove, true)
      window.addEventListener("mouseup", onMouseUp, true)
      // Alt-tabbing away mid-drag: the release lands in another application and
      // no `mouseup` ever arrives here.
      window.addEventListener("blur", stop)
      document.addEventListener("selectionchange", onSelectionChange)
    }

    // Capture, and on the surface rather than the pane: the pane is mounted by
    // ReactFlow below this ref and is replaced whenever the flow remounts.
    surface.addEventListener("mousedown", onMouseDown, true)
    return () => {
      surface.removeEventListener("mousedown", onMouseDown, true)
      stop()
    }
  }, [surfaceRef])
}
