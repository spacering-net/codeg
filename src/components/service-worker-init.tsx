"use client"

import { useEffect } from "react"
import { registerAppServiceWorker } from "@/lib/service-worker"

/**
 * Registers the codeg service worker for the web build. Self-gated: desktop
 * (Tauri), non-secure contexts and development never register — see
 * `@/lib/service-worker`. Failure is silent by design; the next load retries.
 */
export function ServiceWorkerInit() {
  useEffect(() => {
    registerAppServiceWorker()
  }, [])
  return null
}
