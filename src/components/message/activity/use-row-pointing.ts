"use client"

import { useEffect, type RefObject } from "react"

/** The header button of a row that opens (globals.css). */
const TOGGLE = ".activity-row-toggle"
/** A row of a timeline, or of a group's members. */
const ROW = ".activity-item, .activity-child"
/** On the row whose own header button the pointer is over. */
export const ROW_POINTED = "data-row-pointed"
/** On the row whose own header button has visible focus. */
export const ROW_FOCUSED = "data-row-focused"

function focusVisible(element: Element): boolean {
  try {
    return element.matches(":focus-visible")
  } catch {
    // An engine without the selector (an old test DOM) treats any focus as
    // keyboard focus, as the selector's own fallback does.
    return true
  }
}

/**
 * Marks the row whose header button is pointed at (`data-row-pointed`) or
 * has visible focus (`data-row-focused`), so its ring darkens with the
 * button's words (globals.css). The ring sits beside the header, not in it,
 * so the stylesheet cannot reach it from the button; matching the row with
 * `:has()` instead made every row that joined the list — a group's member, a
 * step under a goal — restyle the whole row it joined, every member in it,
 * since a new row might hold the button being pointed at.
 *
 * The row marked is the nearest one holding the button — a row nested in
 * another's panel marks itself, never the row around it. Listens on the list:
 * events from nested lists and group members reach it, so only a top-level
 * list needs it.
 */
export function useRowPointing(
  listRef: RefObject<HTMLElement | null>,
  enabled: boolean
) {
  useEffect(() => {
    const list = listRef.current
    if (!enabled || !list) return
    const hit = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return null
      const toggle = target.closest(TOGGLE)
      if (!toggle || !list.contains(toggle)) return null
      const row = toggle.closest(ROW)
      return row && list.contains(row) ? { toggle, row } : null
    }
    const over = (event: Event) => {
      const found = hit(event.target)
      if (found && !found.row.hasAttribute(ROW_POINTED)) {
        found.row.setAttribute(ROW_POINTED, "")
      }
    }
    const out = (event: Event) => {
      const found = hit(event.target)
      if (!found) return
      // Still over the button, on another of its parts.
      const next = (event as MouseEvent).relatedTarget
      if (next instanceof Node && found.toggle.contains(next)) return
      found.row.removeAttribute(ROW_POINTED)
    }
    // The row marked focused. A button taken out of the page while focused
    // gets no `focusout`, so the next focus in the list clears it.
    let focused: Element | null = null
    const markFocused = (row: Element | null) => {
      if (focused === row) return
      focused?.removeAttribute(ROW_FOCUSED)
      focused = row
      row?.setAttribute(ROW_FOCUSED, "")
    }
    const focusIn = (event: Event) => {
      const found = hit(event.target)
      markFocused(
        found && event.target === found.toggle && focusVisible(found.toggle)
          ? found.row
          : null
      )
    }
    const focusOut = (event: Event) => {
      const found = hit(event.target)
      if (found && event.target === found.toggle) markFocused(null)
    }
    // A button focused by the pointer shows its focus once a key is pressed.
    const keyDown = () => {
      const active = document.activeElement
      const found = active ? hit(active) : null
      if (found && active === found.toggle && focusVisible(found.toggle)) {
        markFocused(found.row)
      }
    }
    list.addEventListener("pointerover", over)
    list.addEventListener("pointerout", out)
    list.addEventListener("focusin", focusIn)
    list.addEventListener("focusout", focusOut)
    list.addEventListener("keydown", keyDown)
    return () => {
      list.removeEventListener("pointerover", over)
      list.removeEventListener("pointerout", out)
      list.removeEventListener("focusin", focusIn)
      list.removeEventListener("focusout", focusOut)
      list.removeEventListener("keydown", keyDown)
      markFocused(null)
    }
  }, [listRef, enabled])
}
