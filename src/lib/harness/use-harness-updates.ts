"use client"

import { useEffect, useRef } from "react"

import { useHarnessSlot, useHarnessView } from "@/contexts/harness-view-context"
import { getTransport, type UnsubscribeFn } from "@/lib/transport"
import { onHarnessInstalledChanged } from "./mcp-install-api"
import {
  HARNESS_UPDATES,
  checkHarnessUpdates,
  checkIsStale,
  onHarnessUpdatesChanged,
  reloadHarnessUpdates,
  subscribeSafely,
} from "./updates"

/**
 * Keep the host's update check answer current for as long as the workspace
 * is up — the sidebar's badge needs it with the Harness page closed. Read
 * once, again on `harness://updates-changed` (a check changed something),
 * on `harness://installed-changed` (an install, an update, an uninstall:
 * the answer is read against what is installed now), and after the event
 * stream reconnects. The count it holds is the badge's.
 */
export function useHarnessUpdatesSync(): void {
  const { slots, setUpdatesCount } = useHarnessView()
  const [state] = useHarnessSlot(HARNESS_UPDATES)
  const count = state.value?.enabled ? state.value.count : 0

  useEffect(() => {
    setUpdatesCount(count)
  }, [count, setUpdatesCount])

  useEffect(() => {
    const reload = () => void reloadHarnessUpdates(slots)
    reload()
    let cancelled = false
    const stops: UnsubscribeFn[] = []
    for (const subscribed of [
      subscribeSafely(() => onHarnessUpdatesChanged(reload)),
      subscribeSafely(() => onHarnessInstalledChanged(reload)),
    ]) {
      void subscribed.then((stop) => {
        if (!stop) return
        if (cancelled) stop()
        else stops.push(stop)
      })
    }
    let stopReconnect: UnsubscribeFn | undefined
    try {
      stopReconnect = getTransport().onReconnect?.(reload)
    } catch {
      // No reconnect hook: the next event or mount reads again.
    }
    return () => {
      cancelled = true
      for (const stop of stops) stop()
      stopReconnect?.()
    }
  }, [slots])
}

/** {@link useHarnessUpdatesSync}, as an element for a layout to mount. */
export function HarnessUpdatesSync(): null {
  useHarnessUpdatesSync()
  return null
}

/**
 * When the MCP or Skills section opens: if the host's last check is over an
 * hour old, ask it to check. Once per visit, as soon as the answer it goes
 * by is in; the host decides whether a check actually runs (not if it tried
 * within the hour).
 */
export function useHarnessUpdatesCheckOnOpen(): void {
  const { slots } = useHarnessView()
  const [state] = useHarnessSlot(HARNESS_UPDATES)
  const asked = useRef(false)
  const value = state.value

  useEffect(() => {
    if (asked.current || !value) return
    asked.current = true
    if (checkIsStale(value, Date.now())) {
      void checkHarnessUpdates(slots, false)
    }
  }, [value, slots])
}
