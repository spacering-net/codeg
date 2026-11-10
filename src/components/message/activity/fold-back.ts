"use client"

import { useCallback } from "react"

import { useMessageScroll } from "../message-scroll-context"

/**
 * Folds a list from the row at its foot. That row is at the bottom of what
 * folds away; the header that stays can be far above it, out of view, and
 * with nothing to hold the view the answer or the next message would slide in
 * under the reader instead. So the header comes into view first — the
 * transcript scrolled up to it, letting go of a stream it was following —
 * and the list folds up under it; a header already in view stays where it
 * is. A control that had the focus (a keyboard press) hands it to the
 * header's toggle, rather than leaving it to the page as the control goes.
 */
export function useFoldBack() {
  const scroll = useMessageScroll()
  return useCallback(
    ({
      head,
      control,
      toggle,
      fold,
    }: {
      /** What stays: the header the list hangs from. */
      head: HTMLElement | null
      /** The control pressed, at the list's foot. */
      control: HTMLElement
      /** Where the focus goes. */
      toggle: HTMLElement | null
      fold: () => void
    }) => {
      const focused = control.ownerDocument.activeElement === control
      if (head) {
        if (scroll) scroll.revealFromAbove(head)
        else head.scrollIntoView({ block: "nearest" })
      }
      fold()
      if (focused) toggle?.focus({ preventScroll: true })
    },
    [scroll]
  )
}

/**
 * Folds a row's open list — a group's members, a sub-agent's own steps —
 * from the row at its foot (see `useFoldBack`): the row that holds the list
 * stays, and its header, the row's toggle, takes the focus.
 */
export function useFoldRow() {
  const foldBack = useFoldBack()
  return useCallback(
    (control: HTMLElement, fold: () => void) => {
      const row = control.closest<HTMLElement>("li[data-step-key]")
      foldBack({
        head: row,
        control,
        toggle: row?.querySelector<HTMLElement>(":scope > button") ?? null,
        fold,
      })
    },
    [foldBack]
  )
}
