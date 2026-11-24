"use client"

/**
 * A spinner on the screen's shared phase (10.8): every one of them points
 * the same way. Under reduced motion it pulses instead (globals.css).
 */

import { Loader2 } from "lucide-react"

import { SPIN_MS, SPIN_SMALL_MS, useSyncedSpin } from "@/lib/motion/synced-spin"
import { cn } from "@/lib/utils"

export function SyncedSpinner({
  small,
  className,
}: {
  /** The quicker one (700ms a turn) for small, short waits. */
  small?: boolean
  className?: string
}) {
  const style = useSyncedSpin(small ? SPIN_SMALL_MS : SPIN_MS)
  return (
    <Loader2
      aria-hidden
      data-slot="synced-spinner"
      className={cn(small ? "motion-spin-small" : "motion-spin", className)}
      style={style}
    />
  )
}
