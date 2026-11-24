"use client"

import { useEffect, useState } from "react"

import { browserCapabilities, browserCapabilitiesSnapshot } from "./browser-api"
import type { BrowserCapabilities } from "./types"

/**
 * The backend's answer to `browser_capabilities`, for rendering decisions:
 * the cached answer at once when it is in (the events bridge asks at
 * startup), else null until the one round trip resolves. Web mode answers
 * "unavailable" immediately.
 */
export function useBrowserCapabilities(): BrowserCapabilities | null {
  const [capabilities, setCapabilities] = useState<BrowserCapabilities | null>(
    browserCapabilitiesSnapshot
  )
  useEffect(() => {
    if (capabilities) return
    let cancelled = false
    void browserCapabilities().then((answer) => {
      if (!cancelled) setCapabilities(answer)
    })
    return () => {
      cancelled = true
    }
  }, [capabilities])
  return capabilities
}
