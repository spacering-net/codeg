"use client"

/**
 * Spinners on one phase (10.8): every spinner and working ring mounts with
 * its animation started "now mod period" ago, so all of them on the screen
 * point the same way however late each mounted. Read once, at mount: the
 * clock then keeps them together.
 */

import { useState, type CSSProperties } from "react"

/** The small spinner's period and the running one's (`--motion-spin-small`,
 *  `--motion-spin`). */
export const SPIN_SMALL_MS = 700
export const SPIN_MS = 1200

/** The animation delay that puts a loop of `periodMs` on the shared phase
 *  at `now`. */
export function syncedDelay(
  periodMs: number,
  now: number = Date.now()
): string {
  const period = Math.max(1, Math.round(periodMs))
  return `-${((now % period) + period) % period}ms`
}

/** The style that puts a loop of `periodMs` on the shared phase, fixed at
 *  mount. */
export function useSyncedSpin(periodMs: number = SPIN_MS): CSSProperties {
  const [style] = useState<CSSProperties>(() => ({
    animationDelay: syncedDelay(periodMs),
  }))
  return style
}
