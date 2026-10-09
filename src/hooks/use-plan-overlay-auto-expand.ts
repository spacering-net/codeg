"use client"

import { useCallback, useEffect, useState } from "react"

import {
  PLAN_OVERLAY_AUTO_EXPAND_EVENT,
  STORAGE_KEY_PLAN_OVERLAY_AUTO_EXPAND,
  readPlanOverlayAutoExpand,
  writePlanOverlayAutoExpand,
} from "@/lib/plan-overlay-prefs"

export function usePlanOverlayAutoExpand(): {
  autoExpand: boolean
  setAutoExpand: (on: boolean) => void
} {
  const [autoExpand, setAutoExpandState] = useState(readPlanOverlayAutoExpand)

  useEffect(() => {
    const sync = () => setAutoExpandState(readPlanOverlayAutoExpand())
    const onStorage = (event: StorageEvent) => {
      if (event.key && event.key !== STORAGE_KEY_PLAN_OVERLAY_AUTO_EXPAND)
        return
      sync()
    }
    window.addEventListener("storage", onStorage)
    window.addEventListener(PLAN_OVERLAY_AUTO_EXPAND_EVENT, sync)
    return () => {
      window.removeEventListener("storage", onStorage)
      window.removeEventListener(PLAN_OVERLAY_AUTO_EXPAND_EVENT, sync)
    }
  }, [])

  const setAutoExpand = useCallback((on: boolean) => {
    setAutoExpandState(on)
    writePlanOverlayAutoExpand(on)
  }, [])

  return { autoExpand, setAutoExpand }
}
