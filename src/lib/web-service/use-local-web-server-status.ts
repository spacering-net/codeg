"use client"

// The desktop web service's status, followed live across windows.
//
// It has three writers — the Settings page, the status-bar toggle, and
// auto-start at launch — and each start/stop is announced on
// `web-service://status-changed` (the backend sends only `running`; the status
// itself carries the token). Subscribed before the first read, so nothing that
// lands in between is missed; a broadcast that lands while a read is in
// flight makes that read stale, and a fresh one is issued.
//
// Only the local desktop has a web service to show: a browser is talking to
// one already (the Settings nav hides the page there), and a remote-desktop
// window's transport targets the remote server. Both answer `undefined`
// without asking anything.

import { useCallback, useEffect, useRef, useState } from "react"

import {
  getWebServerStatus,
  WEB_SERVICE_STATUS_CHANGED_EVENT,
  type WebServerInfo,
} from "@/lib/api"
import { subscribe } from "@/lib/platform"
import { isDesktop, isRemoteDesktopMode } from "@/lib/transport"

/** Whether this window owns a desktop web service it can show and toggle. */
export function hasLocalWebService(): boolean {
  return isDesktop() && !isRemoteDesktopMode()
}

export function useLocalWebServerStatus() {
  /** `undefined` until the first answer (or for good, where there is no
   *  local web service); `null` while stopped. */
  const [status, setStatus] = useState<WebServerInfo | null | undefined>(
    undefined
  )
  const [enabled] = useState(hasLocalWebService)
  /** Bumped by every read issued and every broadcast heard: an answer is
   *  applied only if nothing newer happened since it was asked. */
  const seqRef = useRef(0)
  const aliveRef = useRef(true)

  const refresh = useCallback(async () => {
    if (!enabled) return
    const seq = ++seqRef.current
    try {
      const next = await getWebServerStatus()
      if (aliveRef.current && seq === seqRef.current) setStatus(next)
    } catch {
      // Keep the last known answer; the next broadcast or focus re-asks.
    }
  }, [enabled])

  /** Adopt what a start/stop of this window's own answered — unless a newer
   *  read or broadcast has landed since `since` was taken. */
  const mark = useCallback(() => seqRef.current, [])
  const applySince = useCallback(
    (next: WebServerInfo | null, since: number) => {
      if (aliveRef.current && seqRef.current === since) setStatus(next)
    },
    []
  )

  useEffect(() => {
    aliveRef.current = true
    if (!enabled) return
    let disposed = false
    let unsubscribe: (() => void) | undefined
    subscribe<{ running: boolean }>(WEB_SERVICE_STATUS_CHANGED_EVENT, () => {
      void refresh()
    })
      .then((fn) => {
        if (disposed) fn()
        else unsubscribe = fn
      })
      .catch(() => {})
      .finally(() => {
        if (!disposed) void refresh()
      })
    // A missed broadcast (a window that was busy reloading) heals the next
    // time the window comes back to the front.
    const onFocus = () => void refresh()
    window.addEventListener("focus", onFocus)
    return () => {
      disposed = true
      aliveRef.current = false
      unsubscribe?.()
      window.removeEventListener("focus", onFocus)
    }
  }, [enabled, refresh])

  return { status, enabled, refresh, mark, applySince }
}
