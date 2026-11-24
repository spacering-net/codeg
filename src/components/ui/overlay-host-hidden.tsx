"use client"

import * as React from "react"

/**
 * Whether the surface that owns this overlay is currently hidden-but-mounted.
 *
 * The sibling of `overlay-portal-container.tsx`, and the same class of problem:
 * a layer that portals out of its host's DOM subtree stops obeying anything
 * the host does to that subtree.
 *
 * The workbench keeps the conversation surface MOUNTED when a full-page route
 * (tasks, automations, …) takes over — background sessions have to keep
 * streaming — and merely stops it painting with `conversation-tab-hidden
 * invisible` + `inert` (see `src/app/workspace/layout.tsx`). A drawer opened
 * from that surface portals to `document.body`, which is nowhere near the
 * hidden subtree, so it went on painting over the tasks board and went on
 * taking clicks.
 *
 * Hidden, not closed: the surface behind it is being preserved, so preserving
 * the drawer over it is the consistent answer — switch back and it is still
 * there, still streaming, exactly where it was left.
 *
 * `false` — the default — is right for any overlay whose host unmounts
 * normally, which is every other one in the app.
 */
const OverlayHostHiddenContext = React.createContext(false)

/**
 * Marks everything below as hidden-but-mounted.
 *
 * These NEST — an inactive conversation tab sits inside the workspace surface,
 * which itself hides under a full-page route — so the flag is inherited and
 * additive: a provider can only ever ADD hiding, never clear it. Plain context
 * shadowing would let the inner `hidden={false}` of a "visible" tab un-hide a
 * drawer whose whole workspace is covered.
 */
export function OverlayHostHiddenProvider({
  hidden,
  children,
}: {
  hidden: boolean
  children: React.ReactNode
}) {
  const inherited = useOverlayHostHidden()
  const value = inherited || hidden
  return (
    <OverlayHostHiddenContext.Provider value={value}>
      {children}
    </OverlayHostHiddenContext.Provider>
  )
}

/** Whether an overlay rendered here should stop painting and stop taking input. */
export function useOverlayHostHidden(): boolean {
  return React.useContext(OverlayHostHiddenContext)
}
