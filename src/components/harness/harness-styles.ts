import { cn } from "@/lib/utils"

/**
 * The look the Harness page's sections share, so MCP, Skills and Skill packs
 * read as one page with Discover.
 *
 * One measure for all of them: the page's inset — 16px — on every side of
 * the toolbar (whose controls are all 32px tall, as on the other pages),
 * around the list under it, and around the detail beside it. So the toolbar's
 * first control, the list's cards, a full-width table and a detail's tile all
 * start on the same line, and nothing sits closer to an edge than another.
 */

/** The page's inset, on every side. */
export const HARNESS_INSET_CLASS = "p-4"

/** Around a section's toolbar, at the top of the section. */
export const HARNESS_TOOLBAR_CLASS = cn(
  "flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-4 py-3 ws-chrome-border"
)

/** A toolbar's segmented switch (views, packs), and each of its options. */
export const HARNESS_SEGMENTS_CLASS =
  "no-scrollbar flex h-8 min-w-0 shrink-0 items-center gap-0.5 overflow-x-auto rounded-full bg-muted/70 p-0.5 ws-msg-chip max-md:h-10"
export const HARNESS_SEGMENT_CLASS = cn(
  "h-7 shrink-0 rounded-full px-3 text-[0.8125rem] font-medium whitespace-nowrap max-md:h-9",
  "text-muted-foreground outline-none transition-colors hover:text-foreground",
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
  "data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm",
  "data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm"
)

/** A section's search box (the shared `Input`, made the page's own). */
export const HARNESS_SEARCH_CLASS =
  "h-8 bg-background shadow-xs max-md:h-10 md:text-[0.8125rem] dark:bg-background ws-msg-chip"

/** A toolbar's filter: a filled pill, so it reads as a control at rest. The
 *  heights name the select's own size too, which outranks a bare `h-*`. */
export const HARNESS_FILTER_CLASS = cn(
  "h-8 gap-1.5 rounded-full border-transparent bg-muted/70 px-3 text-[0.8125rem] font-medium shadow-none max-md:h-10",
  "data-[size=default]:h-8 max-md:data-[size=default]:h-10",
  "hover:bg-muted dark:bg-muted/70 dark:hover:bg-muted data-[state=open]:bg-muted"
)

/** The list beside a detail: a quieter ground, so its cards stand on it. */
export const HARNESS_LIST_PANE_CLASS =
  "flex w-[clamp(18rem,34%,24rem)] shrink-0 flex-col border-e border-border/60 bg-muted/30 ws-chrome-border"

/** Inside a list's scroller: the page's inset. */
export const HARNESS_LIST_PAD_CLASS = HARNESS_INSET_CLASS

/** A list of rows: cards, 8px apart. */
export const HARNESS_ROWS_CLASS = "flex min-w-0 flex-col gap-2"

/** A list whose rows come in groups, each under its label. */
export const HARNESS_ROW_GROUPS_CLASS = "flex min-w-0 flex-col gap-4"

/** A row of a list: a card, the whole of it one button. The open one takes
 *  the primary colour's edge and a wash of it. */
export const HARNESS_ROW_CLASS = cn(
  "group/row flex w-full min-w-0 items-center gap-3 rounded-xl border border-border/70 bg-background px-3 py-2.5 text-start outline-none transition-colors",
  "hover:border-border hover:bg-accent/40 focus-visible:ring-[3px] focus-visible:ring-ring/50",
  "aria-[current=true]:border-primary/70 aria-[current=true]:bg-primary/[0.04] aria-[current=true]:hover:bg-primary/[0.06]",
  "dark:bg-card dark:aria-[current=true]:bg-primary/10"
)

/** The square a row leads with: an agent's mark, a server's kind. Tinted with
 *  the primary colour on the open row. */
export const HARNESS_ROW_TILE_CLASS = cn(
  "flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors [&_svg]:size-4",
  "group-aria-[current=true]/row:bg-primary/10 group-aria-[current=true]/row:text-primary"
)

/** A detail's own box: the page's inset on every side. */
export const HARNESS_DETAIL_CLASS =
  "w-full max-w-5xl min-w-0 space-y-5 px-4 pt-4 pb-8"

/** A detail's header: the tile, the heading with a line under it, actions
 *  at its end; a rule closes it. */
export const HARNESS_DETAIL_HEADER_CLASS =
  "min-w-0 space-y-3 border-b border-border/70 pb-4"

/** The tile a detail's header leads with. */
export const HARNESS_DETAIL_TILE_CLASS =
  "flex size-12 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground/70 [&_svg]:size-5"

/** A detail's heading. */
export const HARNESS_DETAIL_TITLE_CLASS =
  "text-xl leading-tight font-semibold tracking-tight break-words outline-none"

/** A small heading over a list's group (a pack's category, "Missing"). */
export const HARNESS_GROUP_LABEL_CLASS =
  "flex items-baseline gap-1.5 px-1 pb-2 text-xs font-medium text-muted-foreground"

/** A part of a detail's box: a card with the page's own rounding. */
export const HARNESS_CARD_CLASS =
  "min-w-0 overflow-hidden rounded-xl border bg-card"
