"use client"

import type { ReactNode } from "react"
import { ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"

const CARD = "min-w-0 rounded-xl border border-border/70 bg-muted/40"

/**
 * A section of the panel, as a card: a header row — the section's icon and
 * title, then at its end a summary of what it holds and the chevron that
 * folds it — then its body. The icon takes the rows' left column, over their
 * step icons and message numbers, so the title lines up with the text of the
 * rows under it. The body renders in either state: what a section still shows
 * while folded is its own business. A `sticky` header stays at the top of the
 * panel while the section scrolls under it, painted the card's colour over
 * the page's so the rows going under it don't show through.
 */
export function SessionDetailsSectionCard({
  icon,
  title,
  summary,
  open,
  onOpenChange,
  sticky = false,
  children,
}: {
  icon: ReactNode
  title: string
  summary: ReactNode
  open: boolean
  onOpenChange: (open: boolean) => void
  sticky?: boolean
  children: ReactNode
}) {
  return (
    <section className={cn(CARD, "px-3 pt-1", open ? "pb-2" : "pb-1")}>
      <h3
        className={cn(
          "min-w-0",
          // Across the card's padding, so rows scrolling under it never show
          // at its sides; rounded with the card's inner corners.
          sticky &&
            "ws-surface sticky top-0 z-10 -mx-3 rounded-t-[calc(var(--radius-lg)-1px)]"
        )}
      >
        <span
          className={cn(
            "block",
            sticky && "rounded-[inherit] bg-muted/40 px-3"
          )}
        >
          <button
            type="button"
            aria-expanded={open}
            onClick={() => onOpenChange(!open)}
            className="group/section flex h-9 w-full min-w-0 items-center gap-2 rounded-md text-start outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <span
              aria-hidden="true"
              className="flex w-7 shrink-0 justify-center text-foreground [&>svg]:size-4"
            >
              {icon}
            </span>
            <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-semibold text-foreground">
              {title}
            </span>
            <span className="shrink-0 text-2xs text-muted-foreground tabular-nums transition-colors group-hover/section:text-foreground">
              {summary}
            </span>
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "me-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-hover/section:text-foreground",
                // Folded it points along the line, at the end it sits at;
                // open, down at what it shows.
                !open && "-rotate-90 rtl:rotate-90"
              )}
            />
          </button>
        </span>
      </h3>
      {children}
    </section>
  )
}
