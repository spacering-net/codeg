"use client"

import { useState, useSyncExternalStore } from "react"

import { useChatAnimationsEnabled } from "@/hooks/use-appearance"
import { REDUCED_MOTION_QUERY } from "@/lib/chat-motion"

// One query and one listener for the window, however many readers: every text
// block of a transcript reads it.
let reducedMotionQuery: MediaQueryList | null | undefined
const reducedMotionReaders = new Set<() => void>()

function reducedMotionList(): MediaQueryList | null {
  if (reducedMotionQuery === undefined) {
    reducedMotionQuery = window.matchMedia?.(REDUCED_MOTION_QUERY) ?? null
    reducedMotionQuery?.addEventListener?.("change", () => {
      for (const reader of reducedMotionReaders) reader()
    })
  }
  return reducedMotionQuery
}

function subscribeReducedMotion(onChange: () => void): () => void {
  reducedMotionList()
  reducedMotionReaders.add(onChange)
  return () => {
    reducedMotionReaders.delete(onChange)
  }
}

function readReducedMotion(): boolean {
  return reducedMotionList()?.matches ?? false
}

/** The system's reduced-motion preference, followed as it changes. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    readReducedMotion,
    () => false
  )
}

/** Whether the chat view moves: Settings → Appearance → "Chat animations" is
 *  on and the system does not ask for less motion (see `@/lib/chat-motion`). */
export function useChatMotion(): boolean {
  const enabled = useChatAnimationsEnabled()
  const reduced = useReducedMotion()
  return enabled && !reduced
}

/**
 * Whether `complete` turned true while the caller was mounted: a reply that
 * finished in front of the reader, whose closing pieces (its stats row, its
 * changed files) fade in as they arrive — not one the virtual list brought
 * back finished, which shows them as they stand.
 */
export function useArrivedOnCompletion(complete: boolean): boolean {
  const [arrived, setArrived] = useState(false)
  const [wasComplete, setWasComplete] = useState(complete)
  if (wasComplete !== complete) {
    setWasComplete(complete)
    if (complete) setArrived(true)
  }
  return arrived && complete
}
