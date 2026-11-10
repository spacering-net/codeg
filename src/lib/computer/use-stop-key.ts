"use client"

// Whether the stop shortcut is in force, for every place that offers Stop:
// kept by `computer://stop-key`, and asked once when the window loads — once
// the listener is in place, so no change can fall between the answer and the
// first broadcast. A broadcast that lands while the answer is on its way is
// the newer of the two.

import { useEffect, useState } from "react"

import { subscribe } from "@/lib/platform"

import { computerStopKeyStatus, useComputerAvailable } from "./computer-api"
import { COMPUTER_STOP_KEY_EVENT, type StopKeyStatus } from "./types"

export function useComputerStopKey(): StopKeyStatus | null {
  const [status, setStatus] = useState<StopKeyStatus | null>(null)
  const available = useComputerAvailable()
  useEffect(() => {
    if (!available) return
    let disposed = false
    let broadcasts = 0
    let unsubscribe: (() => void) | undefined
    const ask = () => {
      if (disposed) return
      computerStopKeyStatus()
        .then((s) => {
          if (!disposed && broadcasts === 0) setStatus(s)
        })
        .catch(() => {})
    }
    void subscribe<StopKeyStatus>(COMPUTER_STOP_KEY_EVENT, (s) => {
      broadcasts += 1
      setStatus(s)
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
  return status
}
