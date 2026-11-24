"use client"

import { createContext, useContext } from "react"
import type { ScrollToIndexOpts } from "virtua"

export interface MessageScrollContextValue {
  scrollToIndex: (index: number, opts?: ScrollToIndexOpts) => void
  /** Scrolls the transcript up to `element` when its top is above the view,
   *  letting go of the stream it was following; leaves it alone otherwise. */
  revealFromAbove: (element: Element) => void
}

const MessageScrollContext = createContext<MessageScrollContextValue | null>(
  null
)

export const MessageScrollProvider = MessageScrollContext.Provider

export function useMessageScroll(): MessageScrollContextValue | null {
  return useContext(MessageScrollContext)
}
