import { useSyncExternalStore } from "react"

/** How often the shared clock ticks: a label in minutes is at most this late. */
const TICK_MS = 30_000

let now = Date.now()
let timer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (timer == null) {
    // Fresh for the first subscriber after a quiet spell.
    now = Date.now()
    timer = setInterval(() => {
      now = Date.now()
      for (const notify of listeners) notify()
    }, TICK_MS)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer != null) {
      clearInterval(timer)
      timer = null
    }
  }
}

function getSnapshot(): number {
  return now
}

/**
 * The time, for labels that count in minutes ("6 minutes ago"): one clock for
 * every label on screen, so they all move together and a list of them
 * re-renders once per tick rather than once per row.
 */
export function useMinuteNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
