"use client"

/**
 * The pieces the personal agent's side panel is built of, the same in each
 * of its tabs:
 * - `PanelSection`: a part of a tab — its title, how many it holds, an
 *   action at its end — over its body.
 * - `PanelGroup`: a folding group inside a part (who a matter waits on, a
 *   group of today): its marker, its name and count, the chevron at its end.
 * - `PanelItem`: one thing in a list, a soft card (shadcn's `Item`): what
 *   leads it, its title, a quiet line and notes under it, its buttons; the
 *   whole card opens what it is about when it opens anything.
 * - `PanelCard`: a folding card (the stats' context, run log, charts): its
 *   title and a summary in its header.
 * Whether a group or card is folded is kept in the page's store, so a
 * switch of tabs keeps it.
 */

import type { ComponentProps, ReactNode } from "react"
import { ChevronDown, type LucideIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
} from "@/components/ui/item"
import { cn } from "@/lib/utils"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

/** The folding parts that start folded; every other one starts open. */
const FOLDED_AT_FIRST: ReadonlySet<string> = new Set([
  "status.runLog",
  "status.details",
])

/** Whether a folding part is open, and the way to fold it. */
export function useFold(key: string): [boolean, (open: boolean) => void] {
  const stored = usePersonalAgentUi((s) => s.auxFolds[key])
  const setFold = usePersonalAgentUi((s) => s.setAuxFold)
  return [stored ?? !FOLDED_AT_FIRST.has(key), (open) => setFold(key, open)]
}

export function PanelSection({
  title,
  count,
  action,
  className,
  children,
  ...props
}: {
  title: ReactNode
  /** How many it holds, after the title. */
  count?: number | null
  /** At the head's end: the way to add one. */
  action?: ReactNode
  children: ReactNode
} & Omit<ComponentProps<"section">, "title">) {
  return (
    <section
      className={cn("flex min-w-0 flex-col gap-2", className)}
      {...props}
    >
      <div className="flex h-7 min-w-0 items-center gap-1.5">
        <h3 className="min-w-0 truncate text-[0.8125rem] font-semibold text-foreground">
          {title}
        </h3>
        {count != null && count > 0 ? (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {count}
          </span>
        ) : null}
        {action ? (
          <div className="ms-auto flex shrink-0 items-center">{action}</div>
        ) : null}
      </div>
      {children}
    </section>
  )
}

/** The tones a group is marked with. */
export type PanelTone =
  | "amber"
  | "primary"
  | "violet"
  | "muted"
  | "faint"
  | "green"

const TONE: Record<PanelTone, string> = {
  amber: "bg-amber-500",
  primary: "bg-primary",
  violet: "bg-violet-500",
  muted: "bg-muted-foreground/50",
  faint: "bg-muted-foreground/30",
  green: "bg-emerald-500",
}

export function PanelGroup({
  fold,
  tone,
  label,
  count,
  strong = false,
  className,
  children,
  ...props
}: {
  /** Its key in the page's store. */
  fold: string
  tone: PanelTone
  label: string
  count: number
  /** What waits on the owner: its count amber. */
  strong?: boolean
  children: ReactNode
} & ComponentProps<"section">) {
  const [open, setOpen] = useFold(fold)
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <section className={cn("flex min-w-0 flex-col", className)} {...props}>
        <CollapsibleTrigger className="group/fold -mx-1.5 flex h-7 min-w-0 items-center gap-2 rounded-lg px-1.5 text-start transition-colors outline-none hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/50">
          <span
            aria-hidden
            className={cn("size-1.5 shrink-0 rounded-full", TONE[tone])}
          />
          <span className="min-w-0 truncate text-xs font-medium text-muted-foreground group-hover/fold:text-foreground">
            {label}
          </span>
          <Badge
            variant="secondary"
            className={cn(
              "h-4 min-w-4 px-1 text-[0.625rem] tabular-nums",
              strong &&
                "bg-amber-500/15 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300"
            )}
          >
            {count}
          </Badge>
          <ChevronDown
            aria-hidden
            className="ms-auto size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=closed]/fold:-rotate-90 rtl:group-data-[state=closed]/fold:rotate-90"
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="flex min-w-0 flex-col gap-1.5 pt-1.5">
          {children}
        </CollapsibleContent>
      </section>
    </Collapsible>
  )
}

/** A kind's icon leading an item, on a small tile. */
export function PanelIcon({
  icon: Icon,
  className,
}: {
  icon: LucideIcon
  className?: string
}) {
  return (
    <span
      className={cn(
        "flex size-5 items-center justify-center rounded-md bg-background text-muted-foreground shadow-xs ring-1 ring-foreground/5",
        className
      )}
    >
      <Icon className="size-3" aria-hidden />
    </span>
  )
}

/** The classes of an item's title, in the button that opens it or not. */
const TITLE =
  "line-clamp-2 min-w-0 flex-1 text-[0.8125rem] leading-snug font-medium break-words text-foreground"

export function PanelItem({
  media,
  title,
  chip,
  meta,
  notes = [],
  onOpen,
  openLabel,
  extra,
  actions,
  className,
  ...props
}: {
  /** What leads it: an avatar, a kind's icon. */
  media?: ReactNode
  title: ReactNode
  /** Where it stands, at the title's end. */
  chip?: ReactNode
  /** A quiet line under the title. */
  meta?: ReactNode
  notes?: ReactNode[]
  onOpen?: (() => void) | null
  openLabel?: string
  /** More under it, before the buttons: a task's card (8.5). */
  extra?: ReactNode
  /** Buttons under it, apart from what opening it does. */
  actions?: ReactNode
} & Omit<ComponentProps<"div">, "title">) {
  return (
    // `ws-msg-card` turns it translucent over a workspace background image,
    // as the cards in the conversation are.
    <Item
      variant="muted"
      size="sm"
      className={cn(
        "ws-msg-card relative flex-nowrap items-start gap-2.5 px-3 py-2.5",
        onOpen && "has-[[data-pa-item-open]:hover]:bg-muted",
        className
      )}
      {...props}
    >
      {media ? <ItemMedia>{media}</ItemMedia> : null}
      <ItemContent className="min-w-0 gap-0.5">
        <div className="flex min-w-0 items-start gap-2">
          {onOpen ? (
            // Its ::after covers the card: a click anywhere on it opens it,
            // but on its buttons, which sit over it.
            <button
              type="button"
              data-pa-item-open
              onClick={onOpen}
              title={openLabel}
              className="flex min-w-0 flex-1 text-start outline-none after:absolute after:inset-0 after:rounded-2xl focus-visible:after:ring-[3px] focus-visible:after:ring-ring/50"
            >
              <span className={TITLE}>{title}</span>
            </button>
          ) : (
            <span className={TITLE}>{title}</span>
          )}
          {chip ? (
            <span className="relative z-10 flex shrink-0 items-center">
              {chip}
            </span>
          ) : null}
        </div>
        {meta ? (
          <ItemDescription className="truncate text-start text-xs">
            {meta}
          </ItemDescription>
        ) : null}
        {notes.map((note, i) => (
          <ItemDescription
            key={i}
            className="text-start text-xs leading-snug break-words"
          >
            {note}
          </ItemDescription>
        ))}
        {extra ? <div className="relative z-10 min-w-0">{extra}</div> : null}
        {actions ? (
          <div className="relative z-10 mt-1.5 flex flex-wrap gap-1">
            {actions}
          </div>
        ) : null}
      </ItemContent>
    </Item>
  )
}

export function PanelCard({
  fold,
  title,
  summary,
  className,
  children,
  ...props
}: {
  /** Its key in the page's store. */
  fold: string
  title: string
  summary?: ReactNode
  children: ReactNode
} & Omit<ComponentProps<"div">, "title">) {
  const [open, setOpen] = useFold(fold)
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <Card className={cn("ws-msg-card gap-0 py-0", className)} {...props}>
        <h3 className="min-w-0">
          <CollapsibleTrigger className="group/fold flex h-10 w-full min-w-0 items-center gap-2 rounded-2xl px-3.5 text-start outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
            <span className="min-w-0 truncate text-[0.8125rem] font-medium text-foreground">
              {title}
            </span>
            {summary != null ? (
              <span className="ms-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                {summary}
              </span>
            ) : null}
            <ChevronDown
              aria-hidden
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=closed]/fold:-rotate-90 rtl:group-data-[state=closed]/fold:rotate-90",
                summary == null && "ms-auto"
              )}
            />
          </CollapsibleTrigger>
        </h3>
        <CollapsibleContent className="min-w-0 px-3.5 pb-3.5">
          {children}
        </CollapsibleContent>
      </Card>
    </Collapsible>
  )
}
