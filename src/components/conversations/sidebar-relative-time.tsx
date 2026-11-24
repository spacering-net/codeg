import { useCallback, useSyncExternalStore } from "react"
import { formatRelative } from "./sidebar-conversation-grouping"

export function createSidebarRelativeClock() {
  let now = Date.now()
  const listeners = new Set<() => void>()
  return {
    read: () => now,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    tick() {
      now = Date.now()
      for (const notify of listeners) notify()
    },
  }
}

export type SidebarRelativeClock = ReturnType<typeof createSidebarRelativeClock>

export function SidebarRelativeTime({
  timestamp,
  clock,
  className,
}: {
  timestamp: string
  clock: SidebarRelativeClock
  className: string
}) {
  const readLabel = useCallback(
    () => formatRelative(timestamp, clock.read()),
    [timestamp, clock]
  )
  const label = useSyncExternalStore(clock.subscribe, readLabel, readLabel)
  return label ? <span className={className}>{label}</span> : null
}
