"use client"

import { useEffect, useRef, type ReactNode } from "react"
import {
  useOverlayScrollbars,
  type UseOverlayScrollbarsParams,
} from "overlayscrollbars-react"

const TILE_SELECTOR = "[data-tile-scroll-item]"

// OverlayScrollbars' content MutationObserver measures the viewport inside its
// callback for every mutation it does not ignore: a `scrollWidth` read, so a
// synchronous style + layout pass over whatever the DOM write just dirtied.
// Tiled, that viewport holds every conversation in the group, so each
// streaming commit — and every frame of a JS-driven shimmer — paid one.
// Only the row can change the scroll width: a tile clips its content and its
// width does not depend on it, so anything strictly inside a tile is ignored.
// A tile's own attributes (class, style) still count — they can resize it.
function ignoreTileContent(mutation: MutationRecord): boolean {
  const node = mutation.target
  // Detached by delivery (React swapped the text node in the same commit):
  // the removal itself is reported on a still-attached ancestor, judged here.
  if (!node.isConnected) return true
  const element =
    node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  return element?.parentElement?.closest(TILE_SELECTOR) != null
}

// Mirrors ui/scroll-area.tsx's ScrollArea with x="scroll" y="hidden".
const TILE_SCROLL_OPTIONS: UseOverlayScrollbarsParams["options"] = {
  scrollbars: {
    theme: "os-theme-codeg",
    autoHide: "leave",
    clickScroll: true,
  },
  overflow: { x: "scroll", y: "hidden" },
  update: { ignoreMutation: ignoreTileContent },
}

/**
 * Horizontal scroller for the tiled conversation row that only pays for
 * OverlayScrollbars while tiling is on. Untiled (the common case) nothing can
 * scroll here — each tab scrolls internally — yet a permanently initialized
 * instance kept reacting to every streaming DOM mutation with a
 * MutationObserver update that forces reflow (`scrollWidth` reads on dirty
 * layout). The host/contents pair renders unconditionally so flipping
 * `canTile` mid-stream never remounts the children (which would tear down a
 * live response); only the OverlayScrollbars decoration is created/destroyed
 * around them.
 *
 * Each tile must carry `data-tile-scroll-item` and clip its own content
 * (`overflow-hidden` with a content-independent width): what renders inside a
 * marked tile is never observed (see `ignoreTileContent`).
 */
export function TileScrollContainer({
  canTile,
  children,
}: {
  canTile: boolean
  children: ReactNode
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const contentsRef = useRef<HTMLDivElement | null>(null)
  // No `defer`: a deferred creation could fire after `canTile` flipped back
  // off (nothing short of unmounting cancels it) and leave an orphaned live
  // instance on the untiled wrapper. Initialization happens on an explicit
  // mode switch here, not in the first-paint path `defer` protects.
  const [initialize, instance] = useOverlayScrollbars({
    options: TILE_SCROLL_OPTIONS,
  })

  useEffect(() => {
    if (!canTile) return
    const host = hostRef.current
    const contents = contentsRef.current
    if (!host || !contents) return
    initialize({
      target: host,
      elements: { viewport: contents, content: contents },
    })
    return () => {
      instance()?.destroy()
    }
  }, [canTile, initialize, instance])

  // data-overlayscrollbars-initialize only while tiled: pre-init it hides
  // native scrollbars, but its stylesheet also forces `overflow: auto` on an
  // uninitialized host, which would override `overflow-hidden` for the
  // untiled state (plain-CSS rules beat layered Tailwind utilities).
  return (
    <div
      ref={hostRef}
      data-overlayscrollbars-initialize={canTile ? "" : undefined}
      className="h-full w-full overflow-hidden"
    >
      {/* h-full carries the height chain while uninitialized; once
          initialized, the OverlayScrollbars stylesheet's flex sizing takes
          over. */}
      <div
        ref={contentsRef}
        data-overlayscrollbars-contents=""
        className="h-full w-full"
      >
        {children}
      </div>
    </div>
  )
}
