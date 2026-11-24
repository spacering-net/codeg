"use client"

/** Where something stands, in a word on its tone: a small rounded pill —
 *  the side panel's cards carry it at their top end, the task strip and the
 *  conversation's result card where the PR ladder is shown (`LadderChip`).
 *  Work still moving pulses a dot before the word. */

import type { ComponentProps } from "react"

import { cn } from "@/lib/utils"

/** A pill's tones: moving sky, waiting on the owner amber, ready teal, a
 *  pull request violet, finished green, failed red, the rest quiet. */
export type PillTone =
  | "sky"
  | "amber"
  | "teal"
  | "violet"
  | "green"
  | "red"
  | "muted"

export const PILL_TONE: Record<PillTone, string> = {
  sky: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  amber: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  teal: "bg-teal-500/15 text-teal-700 dark:text-teal-300",
  violet: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  green: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  red: "bg-red-500/15 text-red-700 dark:text-red-300",
  muted: "bg-muted text-muted-foreground",
}

export function StatusPill({
  tone,
  pulse = false,
  className,
  children,
  ...props
}: {
  tone: PillTone
  /** It is still moving: a dot before the word that pulses. */
  pulse?: boolean
} & ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[0.6875rem] font-medium whitespace-nowrap",
        PILL_TONE[tone],
        className
      )}
      {...props}
    >
      {pulse ? (
        <span
          aria-hidden
          className="size-1.5 rounded-full bg-current motion-safe:animate-pulse"
        />
      ) : null}
      {children}
    </span>
  )
}
