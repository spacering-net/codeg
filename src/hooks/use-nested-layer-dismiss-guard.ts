"use client"

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Ref,
  type RefCallback,
} from "react"

import { attachRef } from "@/lib/attach-ref"

// Radix dismiss events are cancelable `CustomEvent`s; cancelling is all this
// guard needs from them, so it stays structural and works for every surface.
type CancelableDismissEvent = { preventDefault: () => void }

/**
 * Keeps a Radix `Dialog` / `Popover` open when the press that closed a nested
 * layer (a `Select`, a `DropdownMenu`, a modal `Popover`) landed inside it.
 *
 * Radix-only by construction — it reads the inline `pointer-events` Radix
 * writes onto its own layers. `Drawer` is a Base UI surface and needs none of
 * this: its dismissal already ignores presses that pass through its React tree.
 *
 * Why it's needed: those nested layers set `disableOutsidePointerEvents`, which
 * makes Radix write `pointer-events: none` onto every layer below them — our
 * dialog included. A press anywhere in the dialog therefore hit-tests straight
 * through to the overlay, so the dialog reads it as an OUTSIDE press. Radix
 * normally discards it right there: `DismissableLayer` only dismisses when the
 * layer is the top pointer-events-enabled one, and while the menu is open it
 * isn't.
 *
 * But `Dialog`/`Popover` pass `deferPointerDownOutside`, which delays that
 * decision from `pointerdown` to the following `click`. By then the press has
 * already dismissed the nested menu, the menu has unmounted, and the dialog is
 * the top layer again — so the stale press now passes the check and closes the
 * dialog. One click, two layers dismissed.
 *
 * The fix is to re-apply Radix's own test at the moment it was meant to run:
 * sample the layer's `pointer-events` on `pointerdown` (capture phase, ahead of
 * Radix's own document listener) and cancel a dismiss that traces back to a
 * press we were shielded from. Presses that land while the layer is genuinely
 * on top — an overlay click with nothing else open — are untouched.
 *
 * Pass the caller's `ref` in; wire the returned `setNode` to the content as its
 * `ref` and chain `onPointerDownOutside` into the content's handler.
 *
 * `node` is the same element as a rendered value, for callers that need to lay
 * something out against it — `Dialog` publishes it as the portal host for
 * nested layers (see `OverlayPortalContainerProvider`).
 */
export function useNestedLayerDismissGuard<T extends HTMLElement = HTMLElement>(
  forwardedRef?: Ref<T>
) {
  const nodeRef = useRef<T | null>(null)
  const [node, setNodeState] = useState<T | null>(null)
  const shieldedAtPressRef = useRef(false)

  useEffect(() => {
    const onPointerDown = () => {
      // Radix writes the layer's `pointer-events` as an inline style, so this
      // reads its intent directly — no computed-style flush, and unaffected by
      // the `pointer-events-auto` class the content also carries.
      shieldedAtPressRef.current =
        nodeRef.current?.style.pointerEvents === "none"
    }
    // Capture, so it runs before Radix's document-level `pointerdown` listener.
    document.addEventListener("pointerdown", onPointerDown, true)
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true)
  }, [])

  // A callback ref: it hands the node to the guard and to whatever ref the
  // caller passed, which our own `ref` would otherwise have displaced.
  const setNode = useCallback<RefCallback<T>>(
    (node) => {
      nodeRef.current = node
      setNodeState(node)
      const detach = attachRef(forwardedRef, node)
      return () => {
        nodeRef.current = null
        setNodeState(null)
        detach()
      }
    },
    [forwardedRef]
  )

  const onPointerDownOutside = useCallback((event: CancelableDismissEvent) => {
    if (shieldedAtPressRef.current) event.preventDefault()
  }, [])

  return { node, setNode, onPointerDownOutside }
}
