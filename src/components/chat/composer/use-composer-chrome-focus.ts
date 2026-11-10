import {
  useCallback,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from "react"

import { isComposerChromeClick } from "@/components/chat/composer/composer-commands"
import type { RichComposerHandle } from "@/components/chat/composer/rich-composer"

/** The handlers to spread on a composer box's outer element. */
export interface ComposerChromeFocusProps {
  onPointerDown: (event: PointerEvent<HTMLElement>) => void
  onClick: (event: MouseEvent<HTMLElement>) => void
  onMouseDown: (event: MouseEvent<HTMLElement>) => void
}

/** A pointer kind we know is not a mouse; anything unnamed is treated as one. */
function isDirectPointer(pointerType: string | undefined): boolean {
  return pointerType === "touch" || pointerType === "pen"
}

/**
 * Whether the browser speaks Pointer Events at all. Read per event rather than
 * once at module load, so nothing depends on whether this file was first
 * evaluated while prerendering.
 */
function supportsPointerEvents(): boolean {
  return typeof window !== "undefined" && "PointerEvent" in window
}

/**
 * Click-the-blank-chrome-to-type for a composer box: its padding, the dead
 * space below a short draft, the gaps in the action bar. Interactive controls,
 * inline badges and the editor surface own their own clicks and are excluded
 * (see `isComposerChromeClick`), and the caret lands AT the point that was hit
 * rather than at the end of the document, so pressing the padding beside
 * existing text behaves like a native textarea.
 *
 * It takes two events, because neither input kind is served by the other's:
 *
 * - **Mouse — `pointerdown`.** Acting on the press is what every native text
 *   field does, and cancelling it keeps the editor from blurring before we
 *   refocus it (cancelling `pointerdown` also suppresses the compatibility
 *   `mousedown` that would have done the blurring).
 * - **Touch and pen — `click`.** A tap's compatibility `mousedown` arrives
 *   after the gesture has already resolved, so focusing from it does not
 *   reliably raise the soft keyboard — and cancelling it, which the mouse path
 *   needs, is itself enough to stop the keyboard coming up. A real `click` is
 *   inside the activation the tap grants, and a touch that turns into a scroll
 *   never produces one, so nothing fires while the user is only panning.
 *
 * Each kind is handled exactly once: the press path skips touch and pen, and
 * the click path skips everything else — refocusing a mouse on release would
 * collapse a drag selection. An event that names no pointer kind (a scripted
 * `.click()`, say) counts as a mouse.
 *
 * A browser with no Pointer Events at all would fall between the two — nothing
 * dispatches `pointerdown`, and no event names a kind for the click path to act
 * on — so it keeps a plain `mousedown`, which is the single path this had
 * before the split and the only signal such a browser gives. That is the one
 * place mouse and touch stay indistinguishable, and there they were never
 * distinguished anyway.
 *
 * Deliberately NOT gated on the composer being disabled: the editor stays
 * editable while a connection is coming up, so chrome presses must focus then
 * too — otherwise only the existing line of text is live and the blank area
 * below it is dead until the agent is ready.
 */
export function useComposerChromeFocus(
  editorRef: RefObject<RichComposerHandle | null>
): ComposerChromeFocusProps {
  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (isDirectPointer(event.pointerType)) return
      if (!isComposerChromeClick(event.target)) return
      event.preventDefault()
      editorRef.current?.focusAtCoords(event.clientX, event.clientY)
    },
    [editorRef]
  )

  const onClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const native: Event = event.nativeEvent
      const pointerType =
        "pointerType" in native
          ? (native as globalThis.PointerEvent).pointerType
          : undefined
      if (!isDirectPointer(pointerType)) return
      if (!isComposerChromeClick(event.target)) return
      editorRef.current?.focusAtCoords(event.clientX, event.clientY)
    },
    [editorRef]
  )

  const onMouseDown = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      // Where there ARE pointer events, the press path above has already had
      // its say (and cancelling it suppresses this event entirely).
      if (supportsPointerEvents()) return
      if (!isComposerChromeClick(event.target)) return
      event.preventDefault()
      editorRef.current?.focusAtCoords(event.clientX, event.clientY)
    },
    [editorRef]
  )

  return { onPointerDown, onClick, onMouseDown }
}
