"use client"

// cua-driver as Settings shows it: read once, then followed through
// `computer://driver`, which every install, removal and progress step — and a
// starting helper fetching the driver for itself — sends. Subscribed before
// the first read, so nothing that happens in between is missed; a broadcast
// that lands while that read is in flight is newer than it.

import { useCallback, useEffect, useRef, useState } from "react"

import { toErrorMessage } from "@/lib/app-error"
import { subscribe } from "@/lib/platform"

import {
  computerDriverInfo,
  computerDriverInstall,
  computerDriverUninstall,
  useComputerAvailable,
} from "./computer-api"
import { COMPUTER_DRIVER_EVENT, type DriverInfo } from "./types"

export function useComputerDriver() {
  const [info, setInfo] = useState<DriverInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Broadcasts heard so far: an answer to something asked before the last
   *  of them is older than it. */
  const heardRef = useRef(0)
  const available = useComputerAvailable()

  useEffect(() => {
    if (!available) return
    let disposed = false
    let unsubscribe: (() => void) | undefined
    const asked = heardRef.current
    const ask = () => {
      if (disposed) return
      computerDriverInfo()
        .then((read) => {
          if (!disposed && heardRef.current === asked) setInfo(read)
        })
        .catch((e) => {
          if (!disposed) setError(toErrorMessage(e))
        })
    }
    subscribe<DriverInfo>(COMPUTER_DRIVER_EVENT, (next) => {
      heardRef.current += 1
      setInfo(next)
    })
      .then((fn) => {
        if (disposed) fn()
        else unsubscribe = fn
      })
      .catch(() => {})
      .finally(ask)
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [available])

  const run = useCallback(async (action: () => Promise<DriverInfo>) => {
    setError(null)
    const since = heardRef.current
    try {
      const done = await action()
      // The backend told every window as the task moved and when it ended;
      // only if none of that arrived here is the answer the newest word.
      if (heardRef.current === since) setInfo(done)
      return true
    } catch (e) {
      setError(toErrorMessage(e))
      return false
    }
  }, [])

  const install = useCallback(() => run(computerDriverInstall), [run])
  const uninstall = useCallback(() => run(computerDriverUninstall), [run])

  return { info, error, install, uninstall }
}
