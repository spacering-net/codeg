"use client"

import type { ReactNode } from "react"
import { ChevronDown } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * A section of the personal agent panel: a header row — the chevron that
 * folds it, then its title and a summary of what it holds — then its body.
 * The chevron takes the rows' left column, over their step icons and message
 * numbers, so the title lines up with the text of the rows under it. The
 * body renders in either state: what a section still shows while folded is
 * its own business. A `sticky` header stays at the top of the panel while
 * the section scrolls under it.
 */
export function InsightsSection({
  title,
  summary,
  open,
  onOpenChange,
  sticky = false,
  flush = false,
  children,
}: {
  title: string
  summary: ReactNode
  open: boolean
  onOpenChange: (open: boolean) => void
  sticky?: boolean
  /** For a body with no left column of its own (no step icons, no message
   *  numbers): the chevron's stroke sits on the column's edge, where the body
   *  starts and a card above has its border, and the title follows it close.
   *  The body lays itself out flush with that edge. */
  flush?: boolean
  children: ReactNode
}) {
  return (
    <section className="min-w-0">
      <h3
        className={cn(
          "min-w-0",
          // Edge to edge over the panel's padding, so rows scrolling under it
          // never show at its sides.
          sticky && "ws-surface sticky top-0 z-10 -mx-3 px-3"
        )}
      >
        <button
          type="button"
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
          className={cn(
            "group/section flex h-7 w-full min-w-0 items-center rounded-md text-start outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
            flush ? "gap-1.5" : "gap-2"
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "flex shrink-0",
              // The glyph's box has 3px of air before its stroke.
              flush ? "-ms-[3px]" : "w-7 justify-center"
            )}
          >
            <ChevronDown
              className={cn(
                "size-3.5 text-muted-foreground transition-transform group-hover/section:text-foreground",
                !open && "-rotate-90 rtl:rotate-90"
              )}
            />
          </span>
          <span className="min-w-0 truncate text-xs font-semibold text-foreground">
            {title}
          </span>
          <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
            {summary}
          </span>
        </button>
      </h3>
      {children}
    </section>
  )
}
