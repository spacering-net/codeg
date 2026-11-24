"use client"

/** One figure on a tile of its own — a group of its description list: what
 *  it counts, how many, a thin bar of the two it is made of — the first in
 *  the dashboard's ink, the second in its accent (the assistant's face
 *  colour, where it has one) — and a line saying them; at the tile's end,
 *  what it holds besides (a rate). */

import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

import { PANEL_SURFACE } from "../../panel-section"

export function KpiTile({
  label,
  value,
  split,
  sub,
  aside,
  className,
}: {
  label: string
  value: string
  /** What it is made of: the first part, the second. */
  split?: readonly [number, number] | null
  sub?: ReactNode
  aside?: ReactNode
  className?: string
}) {
  const [a, b] = split ?? [0, 0]
  return (
    // Its terms and details straight under the group, laid out on a grid:
    // the figure's down the start, what it holds besides at the end.
    <div
      className={cn(
        PANEL_SURFACE,
        "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] content-start gap-x-3 gap-y-1.5 px-4 py-3.5",
        className
      )}
    >
      <dt className="col-start-1 truncate text-xs text-muted-foreground">
        {label}
      </dt>
      <dd className="col-start-1 text-2xl leading-7 font-semibold tracking-tight text-foreground tabular-nums">
        {value}
      </dd>
      {split && a + b > 0 ? (
        <dd aria-hidden className="col-start-1 flex h-1.5 w-full gap-1">
          {a > 0 ? (
            <span
              className="min-w-1.5 basis-0 rounded-full"
              style={{ flexGrow: a, background: "var(--tu-ink-2)" }}
            />
          ) : null}
          {b > 0 ? (
            <span
              className="min-w-1.5 basis-0 rounded-full"
              style={{ flexGrow: b, background: "var(--tu-accent)" }}
            />
          ) : null}
        </dd>
      ) : null}
      {sub ? (
        <dd className="col-start-1 line-clamp-2 text-[0.6875rem] leading-4 break-words text-muted-foreground tabular-nums">
          {sub}
        </dd>
      ) : null}
      {aside ? (
        <dd className="col-start-2 row-span-4 row-start-1 self-start">
          {aside}
        </dd>
      ) : null}
    </div>
  )
}
