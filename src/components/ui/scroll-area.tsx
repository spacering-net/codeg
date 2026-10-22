"use client"

import { useMemo } from "react"
import {
  OverlayScrollbarsComponent,
  type OverlayScrollbarsComponentRef,
} from "overlayscrollbars-react"
import type { OverlayScrollbarsComponentProps } from "overlayscrollbars-react"

type ScrollAreaProps = {
  children: React.ReactNode
  className?: string
  x?: "scroll" | "hidden"
  y?: "scroll" | "hidden"
  onScroll?: (event: Event) => void
  /**
   * Receives the real scrollable viewport element once OverlayScrollbars has
   * initialized (and `null` on destroy). Needed when an external library — e.g.
   * a `virtua` Virtualizer — must bind to the actual scroll container rather
   * than the host. Because the component initializes with `defer`, reading the
   * viewport synchronously after mount is racy; this fires at the right time.
   */
  onViewportRef?: (element: HTMLElement | null) => void
  /**
   * Writing direction for the scrollport. Worth setting to `"ltr"` for content
   * that is inherently left-to-right whatever the UI language — source code,
   * diffs, paths — because the scroll container's own direction is what fixes
   * both the layout and the sign of `scrollLeft` (an RTL scrollport reports 0
   * at its right edge and counts down into negatives).
   */
  dir?: "ltr" | "rtl"
  ref?: React.Ref<OverlayScrollbarsComponentRef>
}

const BASE_OPTIONS: OverlayScrollbarsComponentProps["options"] = {
  scrollbars: {
    theme: "os-theme-codeg",
    autoHide: "leave",
    clickScroll: true,
  },
}

/**
 * `update` options for an OverlayScrollbars instance that never scrolls
 * sideways: they skip its flow-direction check. Whenever an instance's overflow
 * changes, or it appears, OverlayScrollbars checks whether a reversed flow
 * flips its scroll coordinates. It scrolls the viewport to both ends and back,
 * then stops the next trusted scroll event in the capture phase if its own
 * offset is still where it left it — whichever element scrolled. So a real
 * scroll is lost, of the viewport or of a scroller inside it: a virtua list
 * opened on its current row never hears that it moved, and draws only the row
 * it keeps mounted until the user scrolls. Of what the check looks for, only
 * `direction: rtl` occurs in this app, and it flips only the horizontal axis.
 */
export const SKIP_FLOW_DIRECTION_CHECK = {
  flowDirectionStyles: () => ({}),
}

export function ScrollArea({
  children,
  className,
  x = "hidden",
  y = "scroll",
  onScroll,
  onViewportRef,
  dir,
  ref,
}: ScrollAreaProps) {
  const options = useMemo<OverlayScrollbarsComponentProps["options"]>(
    () => ({
      ...BASE_OPTIONS,
      overflow: { x, y },
      ...(x === "hidden" ? { update: SKIP_FLOW_DIRECTION_CHECK } : {}),
    }),
    [x, y]
  )

  const events = useMemo<OverlayScrollbarsComponentProps["events"]>(
    () => ({
      ...(onScroll ? { scroll: (_instance, event) => onScroll(event) } : {}),
      ...(onViewportRef
        ? {
            initialized: (instance) =>
              onViewportRef(instance.elements().viewport),
            destroyed: () => onViewportRef(null),
          }
        : {}),
    }),
    [onScroll, onViewportRef]
  )

  return (
    <OverlayScrollbarsComponent
      ref={ref}
      className={className}
      dir={dir}
      options={options}
      events={events}
      defer
    >
      {children}
    </OverlayScrollbarsComponent>
  )
}
