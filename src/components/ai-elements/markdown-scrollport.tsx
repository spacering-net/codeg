"use client"

import type { ComponentProps } from "react"
import { OverlayScrollbars, type PartialOptions } from "overlayscrollbars"
import {
  defaultComponents,
  type Components,
  type DefaultComponents,
} from "streamdown"

/** The first signs of a reader on a scrollport, any of which sets it up. */
const WAKE_EVENTS = ["pointerover", "wheel", "touchstart", "focusin"] as const

const SCROLLBARS: PartialOptions = {
  scrollbars: {
    theme: "os-theme-codeg",
    autoHide: "leave",
    clickScroll: true,
  },
}

/**
 * Give a scroll container another component renders — Streamdown's table and
 * code block — the app's overlay scrollbars, in place: the element stays the
 * scrollport and only gains the two scrollbars (OverlayScrollbars with the
 * viewport as its target), so its markup and classes stay its owner's. Returns
 * the teardown, which is what a React 19 ref callback returns.
 *
 * The scrollbars show only while the pointer is over the element, so they are
 * set up the first time it is — or the element is scrolled, touched or focused
 * — not for every table and code block a conversation opens with. Until then
 * the native scrollbar is hidden, as it would be under them.
 */
export function attachOverlayScrollport(node: HTMLElement): () => void {
  let instance: OverlayScrollbars | null = null
  const wake = () => {
    unlisten()
    instance = OverlayScrollbars(
      { target: node, elements: { viewport: node } },
      SCROLLBARS
    )
  }
  const unlisten = () => {
    for (const type of WAKE_EVENTS) node.removeEventListener(type, wake)
  }
  node.setAttribute("data-overlayscrollbars-initialize", "")
  for (const type of WAKE_EVENTS) {
    node.addEventListener(type, wake, { passive: true })
  }
  return () => {
    unlisten()
    instance?.destroy()
    node.removeAttribute("data-overlayscrollbars-initialize")
  }
}

/** A ref for an element that is itself the scrollport. Stable, so a memoized
 *  component handed it does not re-render, nor the scrollbars restart. */
export function overlayScrollportRef(node: HTMLElement | null) {
  return node ? attachOverlayScrollport(node) : undefined
}

/** Streamdown puts the table straight inside its scroll container. */
function tableScrollportRef(table: HTMLTableElement | null) {
  const port = table?.parentElement
  return port ? attachOverlayScrollport(port) : undefined
}

/** Streamdown's own table — copy, download and full-screen controls and all —
 *  on the app's scrollbars. */
function ScrollportTable(props: ComponentProps<DefaultComponents["table"]>) {
  return <defaultComponents.table {...props} ref={tableScrollportRef} />
}

export const scrollportComponents: Components = { table: ScrollportTable }
