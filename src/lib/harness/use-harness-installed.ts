"use client"

import { useEffect } from "react"

import { useHarnessView } from "@/contexts/harness-view-context"
import { onMcpChanged } from "@/lib/mcp/api"
import { onSkillsChanged } from "@/lib/skills/api"
import { getTransport, type UnsubscribeFn } from "@/lib/transport"
import { onHarnessInstalledChanged } from "./mcp-install-api"
import { reloadHarnessInstalled } from "./mcp-install-state"

/** A subscription that cannot be had (a transport without events) is no
 *  subscription; the listing is still read on every visit. */
function subscribeSafely(
  subscribe: () => Promise<UnsubscribeFn>
): Promise<UnsubscribeFn | null> {
  try {
    return subscribe().catch(() => null)
  } catch {
    return Promise.resolve(null)
  }
}

/**
 * Keep the host's listing of what is installed from Harness current while a
 * section that shows it is on screen: read once per visit, again on
 * `harness://installed-changed` (an install, an update, an uninstall,
 * anywhere), on `mcp://changed` (an edit can make an entry "changed here"),
 * on `skills://changed` (a skill's folder replaced or restored), and after
 * the event stream reconnects, since what it missed is lost.
 */
export function useHarnessInstalledSync(): void {
  const { slots } = useHarnessView()
  useEffect(() => {
    const reload = () => void reloadHarnessInstalled(slots)
    reload()
    let cancelled = false
    const stops: UnsubscribeFn[] = []
    for (const subscribed of [
      subscribeSafely(() => onHarnessInstalledChanged(reload)),
      subscribeSafely(() => onMcpChanged(reload)),
      subscribeSafely(() => onSkillsChanged(reload)),
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
      // No reconnect hook: the next visit reads again.
    }
    return () => {
      cancelled = true
      for (const stop of stops) stop()
      stopReconnect?.()
    }
  }, [slots])
}
