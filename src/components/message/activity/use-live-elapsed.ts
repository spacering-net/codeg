"use client"

import { useEffect, useSyncExternalStore } from "react"

/**
 * How long a step has been running, as far as this window has watched it:
 * from the first render that saw it live. Kept per step key outside the tree,
 * so a row that scrolls out of the virtual list and back keeps counting from
 * where it started.
 *
 * One shared one-second ticker drives every running row; it only runs while
 * some row is live.
 */
const MAX_TRACKED = 512
const startedAt = new Map<string, number>()

let now = 0
let timer: ReturnType<typeof setInterval> | null = null
const tickers = new Set<() => void>()

function subscribeTick(listener: () => void): () => void {
  tickers.add(listener)
  if (timer === null) {
    now = Date.now()
    timer = setInterval(() => {
      now = Date.now()
      for (const tick of tickers) tick()
    }, 1000)
  }
  return () => {
    tickers.delete(listener)
    if (tickers.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
}

const noSubscription = () => () => {}

export function useLiveElapsed(key: string, live: boolean): number | null {
  useEffect(() => {
    if (!live || startedAt.has(key)) return
    startedAt.set(key, Date.now())
    if (startedAt.size > MAX_TRACKED) {
      const oldest = startedAt.keys().next().value
      if (oldest !== undefined) startedAt.delete(oldest)
    }
  }, [key, live])
  const current = useSyncExternalStore(
    live ? subscribeTick : noSubscription,
    () => now,
    () => 0
  )
  if (!live) return null
  const start = startedAt.get(key)
  return start !== undefined && current >= start ? current - start : null
}

/** `0:21`, `12:04`, `1:02:09` — a running clock, not a duration label. */
export function formatClock(ms: number): string {
  const total = Math.floor(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const ss = String(seconds).padStart(2, "0")
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${ss}`
  }
  return `${minutes}:${ss}`
}

/** A running step shows its clock once it has run this long. */
export const LIVE_CLOCK_AFTER_MS = 10_000
