"use client"

/** A row of days, one small square each: quiet where nothing happened, in
 *  the accent — deeper the more there was — where something did, red where
 *  something failed. Each says its day and what it held on hover; the whole
 *  is one sentence for a screen reader. */

import { cn } from "@/lib/utils"

export interface DotDay {
  key: string
  /** How many things happened. */
  count: number
  /** Something failed that day. */
  failed: boolean
  /** Its day and what it held, on hover. */
  title: string
}

/** How deep a day's square is, by how many it held. */
function depth(count: number): string {
  return count >= 4 ? "opacity-100" : count >= 2 ? "opacity-75" : "opacity-50"
}

export function DotStrip({
  days,
  label,
  className,
}: {
  days: readonly DotDay[]
  /** What the row shows, read as one. */
  label: string
  className?: string
}) {
  return (
    <div
      role="img"
      aria-label={label}
      className={cn("flex w-full min-w-0 gap-1", className)}
    >
      {days.map((d) => (
        <span
          key={d.key}
          title={d.title}
          data-pa-dot={d.failed ? "failed" : d.count > 0 ? "some" : "none"}
          className={cn(
            "h-4 min-w-0 flex-1 rounded-[0.25rem]",
            // A failure first: a day can see one with nothing handed out
            // (work from the day before failing).
            d.failed
              ? "bg-red-500"
              : d.count === 0
                ? "bg-muted"
                : depth(d.count)
          )}
          style={
            d.count > 0 && !d.failed
              ? { background: "var(--tu-accent)" }
              : undefined
          }
        />
      ))}
    </div>
  )
}
