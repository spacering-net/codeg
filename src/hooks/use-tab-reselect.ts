"use client"

import {
  useCallback,
  useMemo,
  useRef,
  type MouseEvent,
  type PointerEvent,
} from "react"

/**
 * Turns a click on a Radix tab that was ALREADY selected into `onReselect` —
 * the aux panel closes itself on one, the way an editor's activity bar hides
 * its side bar when the open view's icon is clicked again.
 *
 * Radix gives no signal for it: Tabs never calls `onValueChange` for the value
 * it already holds. Nor can the click itself tell, because a trigger activates
 * on mousedown — by the time the click lands, that same press has selected the
 * tab, and a first click on another tab would read as a second one. So whether
 * the tab was selected is read at pointerdown, before Radix's mousedown runs,
 * and acted on at the click, once the press is known to have been a click: a
 * press that turns into a drag calls `cancel`, and a touch the browser takes
 * over for scrolling ends in pointercancel.
 *
 * Pointer clicks only. A click the keyboard synthesizes (`detail` 0: Enter or
 * Space on a focused tab) still just keeps the tab selected, as tabs do —
 * closing the panel from there would drop focus to the page along with the
 * rail it sat on. The panel's toggle and shortcut close it from the keyboard.
 */
export function useTabReselect(selected: boolean, onReselect: () => void) {
  const armedRef = useRef(false)

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      // The press Radix itself activates on: the primary button, without the
      // Control that turns a macOS click into a right click.
      armedRef.current = selected && event.button === 0 && !event.ctrlKey
    },
    [selected]
  )

  const cancel = useCallback(() => {
    armedRef.current = false
  }, [])

  const onClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const armed = armedRef.current
      armedRef.current = false
      if (armed && event.detail > 0) onReselect()
    },
    [onReselect]
  )

  const triggerProps = useMemo(
    () => ({ onPointerDown, onPointerCancel: cancel, onClick }),
    [onPointerDown, cancel, onClick]
  )

  return { triggerProps, cancel }
}
