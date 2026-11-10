"use client"

import { useEffect, useState } from "react"

/**
 * Whether a one-line `truncate`d node cuts its text short.
 *
 * Measured when the browser lays the node out — an observer reports a node as
 * it starts observing it, and again on every resize — never by a synchronous
 * read from inside React's effects. `ref` is a callback ref, so a node the
 * parent swaps for another (a row header turning from a `div` into a `button`)
 * is measured afresh; pass whatever identifies the text as `contentKey`, so a
 * changed text that leaves the node's box as it was is measured again too.
 */
export function useTruncation<T extends HTMLElement>(
  contentKey: unknown
): {
  ref: (node: T | null) => void
  truncated: boolean
} {
  const [node, setNode] = useState<T | null>(null)
  const [truncated, setTruncated] = useState(false)

  useEffect(() => {
    if (!node) return
    const observer = new ResizeObserver(() => {
      setTruncated(node.scrollWidth > node.clientWidth)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [node, contentKey])

  return { ref: setNode, truncated }
}
