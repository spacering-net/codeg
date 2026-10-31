"use client"

import { createContext, useContext } from "react"

/**
 * The composer's quote handler for `render_page` frames replayed inside the
 * transcript. The message-list view provides it wherever a composer can
 * receive a quote; the pinned awaiting-answer card takes the same handler as
 * a plain prop. A frame with no provider (a sub-agent dialog, a read-only
 * surface) simply offers no quote action, only copy.
 */
export const RenderPageQuoteContext = createContext<
  ((text: string) => void) | null
>(null)

/** The quote handler a replayed page should offer, or null for copy-only. */
export function useRenderPageQuote(): ((text: string) => void) | null {
  return useContext(RenderPageQuoteContext)
}

/**
 * The composer's annotation handler, provided next to the quote handler
 * wherever a composer exists. Unlike a quote it receives the already
 * formatted annotation text (page title, viewport, note, marks) verbatim —
 * the annotation is the message, not material to wrap in one.
 */
export const RenderPageAnnotateContext = createContext<
  ((text: string) => void) | null
>(null)

/** The annotation handler a replayed page should offer, or null for none. */
export function useRenderPageAnnotate(): ((text: string) => void) | null {
  return useContext(RenderPageAnnotateContext)
}
