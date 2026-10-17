"use client"

/**
 * Collapsed chip for the inline-start conversation overlays (the message
 * navigator, the plan panel, and the sub-agent panel).
 *
 * Rests as a dimmed bullet — a flat start-side edge with a rounded end-side (a
 * "bullet" pointing toward where it expands: right in LTR, mirrored in RTL),
 * flush to the inline-start edge; minimal and unobtrusive so it doesn't crowd
 * the message area, and brightens to full opacity on hover/focus. Built from
 * logical properties (`rounded-s/e`, `pe`, an `rtl:`-flipped chevron) so it
 * mirrors cleanly under `dir="rtl"`. The summary is `display:none` at rest, so
 * the resting button is the 20px icon cap (flat start-side, round end-side, no
 * way for text to leak); on hover or keyboard focus it switches to `flex` and
 * reveals the full pill (summary + chevron). Clicking it expands the owning
 * overlay into its card. Shared so all three chips stay pixel identical.
 *
 * `summary` is the visible text AND the button's accessible name (`aria-label`),
 * so what a screen reader / voice-control user gets matches what a sighted user
 * reads on hover (WCAG 2.5.3); `aria-expanded` conveys the collapsed disclosure
 * state. A 1px border traces the top, bottom, and rounded end — the flush
 * start edge stays open; keyboard focus adds an inset `ring`.
 */

import type { ReactNode } from "react"
import { ChevronRightIcon } from "lucide-react"

import { cn } from "@/lib/utils"

interface CollapsedOverlayChipProps {
  /** Leading icon, shown alone when resting. Pass it sized (e.g. `size-3.5`). */
  icon: ReactNode
  /** Summary text revealed on hover/focus, e.g. "子智能体 3" / "计划 2/5". Also
   *  the button's accessible name. */
  summary: string
  /** Expands the owning overlay into its full card. */
  onClick: () => void
  /** Which edge the chip is flush against. `start` (default) is the inline-start
   *  edge the overlay stack pins to; `end` mirrors it for an overlay anchored to
   *  the inline-end edge (flat side and chevron flip). */
  edge?: "start" | "end"
}

export function CollapsedOverlayChip({
  icon,
  summary,
  onClick,
  edge = "start",
}: CollapsedOverlayChipProps) {
  const atEnd = edge === "end"
  return (
    <div className="pointer-events-none flex">
      <button
        type="button"
        aria-label={summary}
        aria-expanded={false}
        onClick={onClick}
        className={cn(
          "group/chip pointer-events-auto flex items-center border-y",
          atEnd
            ? "rounded-e-none rounded-s-full border-s"
            : "rounded-s-none rounded-e-full border-e",
          "bg-secondary/70 text-secondary-foreground opacity-60 shadow-md transition-[background-color,opacity] duration-150 hover:bg-secondary hover:opacity-100 focus-visible:opacity-100",
          "cursor-pointer outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50"
        )}
      >
        {/* Fixed icon cap — the whole resting chip is just this bullet cap. */}
        <span className="grid size-5 shrink-0 place-items-center">{icon}</span>
        {/* Summary: hidden at rest (no width), revealed on hover/focus. */}
        <span
          className={cn(
            "hidden items-center gap-1 whitespace-nowrap text-sm font-medium group-hover/chip:flex group-focus-visible/chip:flex",
            atEnd ? "ps-3" : "pe-3"
          )}
        >
          {summary}
          <ChevronRightIcon
            className={cn(
              "size-3 shrink-0 text-muted-foreground rtl:-scale-x-100",
              atEnd && "-scale-x-100 rtl:scale-x-100"
            )}
          />
        </span>
      </button>
    </div>
  )
}
