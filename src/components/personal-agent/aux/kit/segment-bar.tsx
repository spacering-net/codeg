"use client"

/** How a whole splits: a thin bar of segments, each as long as its share,
 *  and under it a legend — a dot of its colour, its name, how many. The
 *  empty parts are left out. Read as one sentence by a screen reader. */

import { cn } from "@/lib/utils"

export type SegmentTone = "green" | "red" | "amber" | "muted" | "sky"

const DOT: Record<SegmentTone, string> = {
  green: "bg-emerald-500",
  red: "bg-red-500",
  amber: "bg-amber-500",
  muted: "bg-muted-foreground/40",
  sky: "bg-sky-500",
}

export interface Segment {
  key: string
  label: string
  value: number
  tone: SegmentTone
}

export function SegmentBar({
  segments,
  className,
}: {
  segments: readonly Segment[]
  className?: string
}) {
  const shown = segments.filter((s) => s.value > 0)
  if (shown.length === 0) return null
  const said = shown.map((s) => `${s.label} ${s.value}`).join(", ")
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <div role="img" aria-label={said} className="flex h-1.5 w-full gap-1">
        {shown.map((s) => (
          <span
            key={s.key}
            data-pa-segment={s.key}
            className={cn("min-w-1.5 basis-0 rounded-full", DOT[s.tone])}
            style={{ flexGrow: s.value }}
          />
        ))}
      </div>
      <ul
        aria-hidden
        className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"
      >
        {shown.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span className={cn("size-1.5 rounded-full", DOT[s.tone])} />
            <span>{s.label}</span>
            <span className="text-foreground tabular-nums">{s.value}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
