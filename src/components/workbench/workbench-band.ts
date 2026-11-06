"use client"

import { createContext, useContext } from "react"

/**
 * The desktop window-chrome band (the h-10 strip at the window's top edge,
 * under the fixed corner overlays), when a full-page route draws it itself
 * rather than the shell drawing it above the page: the page then reaches
 * the window's top edge, so a side panel of its own can put its strip in
 * that band — as the workspace's aux panel does — instead of under it. The
 * shell hands over what it would have kept clear there (see
 * `ChromeReserve`).
 */
export interface WorkbenchBand {
  /** The left corner's slot: the left overlay's width while the sidebar is
   *  collapsed, 0 while the sidebar covers the corner; it slides with the
   *  sidebar's toggle. */
  leftCornerWidth: number
  /** What a strip at the window's right edge keeps clear for the right
   *  overlay (and the Win/Linux caption buttons). */
  rightReserve: number
}

export const WorkbenchBandContext = createContext<WorkbenchBand | null>(null)

/** The band, when the shell left it to this page to draw; null when the
 *  shell drew it (a narrow screen, or a route that draws no band). */
export function useWorkbenchBand(): WorkbenchBand | null {
  return useContext(WorkbenchBandContext)
}
