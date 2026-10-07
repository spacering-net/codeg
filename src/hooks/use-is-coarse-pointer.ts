"use client"

import { useEffect, useState } from "react"

// The primary pointer is a finger (a phone, a tablet), not a mouse or trackpad.
const COARSE_POINTER_QUERY = "(pointer: coarse)"

/**
 * Whether the primary pointer is coarse right now. For a decision taken at one
 * moment, such as whether an automatic focus may raise the soft keyboard, where
 * `useIsCoarsePointer` would give every caller a listener and a re-render on
 * each pointer change for a value nothing is drawn from.
 */
export function isPrimaryPointerCoarse(): boolean {
  return window.matchMedia(COARSE_POINTER_QUERY).matches
}

export function useIsCoarsePointer() {
  const [isCoarsePointer, setIsCoarsePointer] = useState(false)

  useEffect(() => {
    const query = window.matchMedia(COARSE_POINTER_QUERY)
    const update = () => setIsCoarsePointer(query.matches)

    update()
    query.addEventListener("change", update)
    return () => query.removeEventListener("change", update)
  }, [])

  return isCoarsePointer
}
