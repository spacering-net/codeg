"use client"

import {
  useCallback,
  useLayoutEffect,
  useRef,
  type HTMLAttributes,
  type Ref,
} from "react"
import { OverlayScrollbars, type PartialOptions } from "overlayscrollbars"

import { SKIP_FLOW_DIRECTION_CHECK } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

const OPTIONS: PartialOptions = {
  scrollbars: {
    theme: "os-theme-codeg",
    autoHide: "leave",
    clickScroll: true,
  },
  overflow: { x: "hidden", y: "scroll" },
  update: SKIP_FLOW_DIRECTION_CHECK,
}

type HarnessScrollerProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  "className"
> & {
  /** On the outer box: its size and place in the layout. */
  className?: string
  /** On the element that scrolls. OverlayScrollbars zeroes its padding, so
   *  spacing goes on a child. */
  viewportClassName?: string
  /** The element that scrolls — what `scrollTop`, `onScroll` and `focus()`
   *  are about, as they were on the plain `overflow-y-auto` box this
   *  replaces. */
  ref?: Ref<HTMLDivElement>
}

/**
 * A vertical scroller with the conversation list's overlay scrollbar
 * (`os-theme-codeg`: thin, over the content, gone when the pointer leaves).
 *
 * Unlike `ScrollArea`, the scrolling element is a plain div of ours from the
 * first frame: OverlayScrollbars takes it as its viewport, and it is set up in
 * a layout effect rather than deferred, so a section that puts its offset back
 * in its own layout effect — which runs after this one, its child's — writes
 * to the element that really scrolls. Everything else passed is put on that
 * element too.
 */
export function HarnessScroller({
  className,
  viewportClassName,
  ref,
  children,
  ...viewportProps
}: HarnessScrollerProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)

  const setViewport = useCallback(
    (element: HTMLDivElement | null) => {
      viewportRef.current = element
      if (typeof ref === "function") ref(element)
      else if (ref) ref.current = element
    },
    [ref]
  )

  useLayoutEffect(() => {
    const host = hostRef.current
    const viewport = viewportRef.current
    if (!host || !viewport) return
    let instance: OverlayScrollbars | null = null
    try {
      instance = OverlayScrollbars(
        { target: host, elements: { viewport, content: viewport } },
        OPTIONS
      )
    } catch {
      // No layout to measure (a test): the box scrolls natively.
    }
    return () => instance?.destroy()
  }, [])

  return (
    <div
      ref={hostRef}
      data-harness-scroller=""
      className={cn("min-h-0 min-w-0 overflow-y-auto", className)}
    >
      <div
        ref={setViewport}
        {...viewportProps}
        className={cn("min-w-0 outline-none", viewportClassName)}
      >
        {children}
      </div>
    </div>
  )
}
