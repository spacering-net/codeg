"use client"

import * as React from "react"

/**
 * Where a nested overlay layer (a `Popover`, and anything else that portals)
 * should render. `null` — the default — means the body, which is what a layer
 * opened from ordinary page content wants.
 *
 * A modal `Dialog` overrides it with its own content element, and that is
 * load-bearing rather than cosmetic. Radix locks page scrolling with
 * `react-remove-scroll`, which whitelists exactly one subtree: the content
 * element, handed to it as a "shard". Its document-level `wheel` listener
 * `preventDefault`s any event whose target falls outside that subtree — so a
 * popover portalled to the body opens fine, filters fine, and scrolls only if
 * you drag its scrollbar, because every wheel tick over it is cancelled.
 * Rendering it inside the content puts it back inside the shard.
 *
 * A `Drawer` overrides it too, for a different reason: it is non-modal, so
 * there is no scroll lock to escape, but keeping nested layers DOM-contained
 * keeps a press inside one from reading as an outside press. It publishes its
 * *popup*, not its content — see the comment at that call site.
 *
 * Layout is unaffected: Radix positions popper content `fixed`, so it is
 * neither clipped by the content's own scrolling nor counted as a flow child
 * of it.
 */
const OverlayPortalContainerContext = React.createContext<HTMLElement | null>(
  null
)

export function OverlayPortalContainerProvider({
  container,
  children,
}: {
  container: HTMLElement | null
  children: React.ReactNode
}) {
  return (
    <OverlayPortalContainerContext.Provider value={container}>
      {children}
    </OverlayPortalContainerContext.Provider>
  )
}

/** The host a nested layer should portal into, or `null` for the body. */
export function useOverlayPortalContainer(): HTMLElement | null {
  return React.useContext(OverlayPortalContainerContext)
}
