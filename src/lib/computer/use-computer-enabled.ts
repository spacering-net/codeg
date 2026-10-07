"use client"

// Whether computer use is switched on, followed live: the settings record
// has several writers (the in-conversation tools panel, the Computer use
// settings page, the status-bar popover), and each tells the others through
// `computer-tools-settings://changed`.
//
// Subscribed before the first read, so nothing that lands in between is
// missed; a broadcast that lands while that read is in flight is newer than
// it. `null` until one or the other has answered.

import { useCallback, useEffect, useRef, useState } from "react"

import { subscribe } from "@/lib/platform"

import { getComputerToolsSettings, useComputerAvailable } from "./computer-api"
import {
  COMPUTER_TOOLS_SETTINGS_CHANGED_EVENT,
  type ComputerToolsSettings,
} from "./types"

export function useComputerEnabled({
  desktopOnly,
}: {
  /** Never asks where computer use is not served (answers `null` there):
   *  for what only exists with it, like the status-bar popover. */
  desktopOnly: boolean
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  /** Broadcasts heard so far: an answer to something asked before the last
   *  of them is older than it. */
  const heardRef = useRef(0)
  const available = useComputerAvailable()

  useEffect(() => {
    if (desktopOnly && !available) return
    let disposed = false
    let unsubscribe: (() => void) | undefined
    const asked = heardRef.current
    const ask = () => {
      if (disposed) return
      getComputerToolsSettings()
        .then((s) => {
          if (!disposed && heardRef.current === asked) setEnabled(s.enabled)
        })
        .catch(() => {})
    }
    subscribe<ComputerToolsSettings>(
      COMPUTER_TOOLS_SETTINGS_CHANGED_EVENT,
      (s) => {
        heardRef.current += 1
        setEnabled(s.enabled)
      }
    )
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
  }, [desktopOnly, available])

  /** Where the broadcasts stand, to hand back to {@link applySince}. */
  const mark = useCallback(() => heardRef.current, [])

  /** The record a write answered with — unless a broadcast has landed since
   *  `since` was marked: that one is newer (another window's write, or this
   *  write's own). */
  const applySince = useCallback(
    (settings: ComputerToolsSettings, since: number) => {
      if (heardRef.current === since) setEnabled(settings.enabled)
    },
    []
  )

  return { enabled, mark, applySince }
}
