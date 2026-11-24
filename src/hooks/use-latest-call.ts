"use client"

import { useCallback, useRef } from "react"

/**
 * For a load a component can start again before the last one answered — a
 * Refresh button pressed twice. `begin()` marks a new call and returns a check
 * that stays true only while no later call has begun, so a late answer,
 * success or failure, never overwrites the newer one.
 *
 * ```ts
 * const beginLoad = useLatestCall()
 * const load = useCallback(async () => {
 *   const current = beginLoad()
 *   const data = await fetchIt()
 *   if (current()) setData(data)
 * }, [beginLoad])
 * ```
 */
export function useLatestCall(): () => () => boolean {
  const latest = useRef(0)
  return useCallback(() => {
    const call = ++latest.current
    return () => call === latest.current
  }, [])
}
