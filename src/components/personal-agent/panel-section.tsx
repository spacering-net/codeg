"use client"

/**
 * The pieces the personal agent's side panel is built of, the same in each
 * of its tabs:
 * - `PanelSection`: a part of a tab — its title, how many it holds, an
 *   action at its end — over its body.
 * - `PanelGroup`: a folding group inside a part (who a matter waits on, a
 *   group of today): a head only as wide as its marker, its name, its
 *   count and the chevron after them — as the roster's heads are — over
 *   its rows, one list.
 * - `PanelList`: rows on one surface, a hairline between them (an inset
 *   grouped list): what a group, a day of output or the routines hold.
 * - `PanelItem`: one thing in a list (shadcn's `Item`): what leads it, its
 *   title and when, where it stands and a quiet line under it, notes, its
 *   buttons; the whole row opens what it is about when it opens anything.
 *   Outside a list — the morning brief's rows in its bubble — a soft card
 *   of its own.
 * - `PanelEmpty`: a list with nothing in it, a dashed line saying so.
 * - `PanelCard`: a folding card (the stats' context, run log, charts): its
 *   title and a summary in its header.
 * Whether a group or card is folded is kept in the page's store, so a
 * switch of tabs keeps it.
 */

import {
  createContext,
  useContext,
  type ComponentProps,
  type ReactNode,
} from "react"
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

/** The surface the panel's lists and cards sit on: the card's colour — a
 *  step above the panel in the dark — and a hairline round it. */
export const PANEL_SURFACE =
  "ws-msg-card rounded-xl border border-border/70 bg-card"
const SURFACE = PANEL_SURFACE

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
      className={cn("flex min-w-0 flex-col gap-2.5", className)}
      {...props}
    >
      <div className="flex h-6 min-w-0 items-center gap-1.5">
        <h3 className="min-w-0 truncate text-[0.8125rem] font-semibold text-foreground">
          {title}
        </h3>
        {count != null && count > 0 ? (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {count}
          </span>
        ) : null}
        {action ? (
          <div className="-me-1 ms-auto flex shrink-0 items-center">
            {action}
          </div>
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
  more,
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
  /** The list's last row: the way to show the rest of it. */
  more?: ReactNode
  /** Its rows: `PanelItem`s. */
  children: ReactNode
} & ComponentProps<"section">) {
  const [open, setOpen] = useFold(fold)
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <section className={cn("flex min-w-0 flex-col", className)} {...props}>
        {/* Only its words and chevron press it, as on the roster: the row's
            blank beyond them is not a button. */}
        <div className="flex h-6 min-w-0 items-center">
          <CollapsibleTrigger className="group/fold -mx-1.5 flex h-6 max-w-[calc(100%+0.75rem)] min-w-0 items-center gap-1.5 rounded-md px-1.5 text-start transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50">
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
              className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=closed]/fold:-rotate-90 rtl:group-data-[state=closed]/fold:rotate-90"
            />
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent className="min-w-0 pt-1.5">
          <PanelList>
            {children}
            {more}
          </PanelList>
        </CollapsibleContent>
      </section>
    </Collapsible>
  )
}

/** Whether an item sits in a `PanelList` (a row) or on its own (a card). */
const InListContext = createContext(false)

/** Whether the item being drawn is a list's row: its lead a size up. */
export function useInPanelList(): boolean {
  return useContext(InListContext)
}

/** Rows on one surface, a hairline between them. */
export function PanelList({
  className,
  children,
  ...props
}: ComponentProps<"div">) {
  return (
    <InListContext value>
      <div
        role="list"
        className={cn(
          SURFACE,
          "flex min-w-0 flex-col overflow-hidden",
          className
        )}
        {...props}
      >
        {children}
      </div>
    </InListContext>
  )
}

/** A list's last row that shows the rest of it, its words under the rows'
 *  titles. */
export function PanelMoreRow({ children, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className="flex h-9 w-full items-center ps-12 pe-3 text-start text-xs text-muted-foreground transition-colors outline-none hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
      {...props}
    >
      {children}
    </button>
  )
}

/** A list with nothing in it: what that means, on a dashed line, and what
 *  would fill it at its end. */
export function PanelEmpty({
  icon: Icon,
  action,
  className,
  children,
  ...props
}: {
  icon?: LucideIcon
  action?: ReactNode
  children: ReactNode
} & ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2.5 rounded-xl border border-dashed border-border px-3 py-2.5",
        className
      )}
      {...props}
    >
      {Icon ? (
        <Icon
          className="size-4 shrink-0 text-muted-foreground/70"
          aria-hidden
        />
      ) : null}
      <p className="min-w-0 flex-1 text-xs leading-5 text-muted-foreground">
        {children}
      </p>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}

/** A kind's icon leading an item, on a small tile: a list row's a size up,
 *  as its avatars are. */
export function PanelIcon({
  icon: Icon,
  className,
}: {
  icon: LucideIcon
  className?: string
}) {
  const inList = useInPanelList()
  return (
    <span
      className={cn(
        "flex items-center justify-center text-muted-foreground",
        inList
          ? "size-6 rounded-lg bg-muted"
          : "size-5 rounded-md bg-background shadow-xs ring-1 ring-foreground/5",
        className
      )}
    >
      <Icon className={inList ? "size-3.5" : "size-3"} aria-hidden />
    </span>
  )
}

/** The classes of an item's title, in the button that opens it or not. */
const TITLE =
  "line-clamp-2 min-w-0 flex-1 text-[0.8125rem] leading-5 font-medium break-words text-foreground"

export function PanelItem({
  media,
  title,
  time,
  aside,
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
  /** When, short, at the title's end. */
  time?: ReactNode
  /** Its own controls at the title's end (a switch, a menu). */
  aside?: ReactNode
  /** Where it stands, leading the quiet line under the title. */
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
  const inList = useInPanelList()
  return (
    <Item
      role={inList ? "listitem" : undefined}
      variant={inList ? "default" : "muted"}
      size="sm"
      className={cn(
        "relative flex-nowrap items-start gap-3 px-3 py-2.5",
        inList
          ? // A hairline under each row but the list's last.
            "rounded-none border-x-0 border-t-0 border-b-border/60 last:border-b-0"
          : // `ws-msg-card` turns it translucent over a workspace
            // background image, as the cards in the conversation are.
            "ws-msg-card gap-2.5",
        onOpen &&
          (inList
            ? "has-[[data-pa-item-open]:hover]:bg-muted/50"
            : "has-[[data-pa-item-open]:hover]:bg-muted"),
        className
      )}
      {...props}
    >
      {media ? (
        <ItemMedia
          className={cn(
            "translate-y-0 self-start group-has-data-[slot=item-description]/item:translate-y-0",
            // Its middle on the title's first line.
            inList && "-mt-0.5"
          )}
        >
          {media}
        </ItemMedia>
      ) : null}
      <ItemContent className="min-w-0 gap-0.5">
        <div className="flex min-w-0 items-start gap-2">
          {onOpen ? (
            // Its ::after covers the item: a click anywhere on it opens it,
            // but on its buttons, which sit over it.
            <button
              type="button"
              data-pa-item-open
              onClick={onOpen}
              title={openLabel}
              className={cn(
                "flex min-w-0 flex-1 text-start outline-none after:absolute after:inset-0",
                inList
                  ? "focus-visible:after:ring-2 focus-visible:after:ring-ring/50 focus-visible:after:ring-inset"
                  : "after:rounded-2xl focus-visible:after:ring-[3px] focus-visible:after:ring-ring/50"
              )}
            >
              <span className={TITLE}>{title}</span>
            </button>
          ) : (
            <span className={TITLE}>{title}</span>
          )}
          {time ? (
            <span className="shrink-0 text-[0.6875rem] leading-5 text-muted-foreground tabular-nums">
              {time}
            </span>
          ) : null}
          {aside ? (
            <span className="relative z-10 -my-0.5 -me-1 flex shrink-0 items-center">
              {aside}
            </span>
          ) : null}
        </div>
        {chip || meta ? (
          <div className="flex min-w-0 items-center gap-1.5">
            {chip ? (
              <span className="relative z-10 flex shrink-0 items-center">
                {chip}
              </span>
            ) : null}
            {meta ? (
              <ItemDescription className="min-w-0 truncate text-start text-xs leading-5">
                {meta}
              </ItemDescription>
            ) : null}
          </div>
        ) : null}
        {notes.map((note, i) => (
          <ItemDescription
            key={i}
            className="text-start text-xs leading-[1.125rem] break-words"
          >
            {note}
          </ItemDescription>
        ))}
        {extra ? <div className="relative z-10 min-w-0">{extra}</div> : null}
        {actions ? (
          <div className="relative z-10 mt-2 flex flex-wrap gap-1.5">
            {actions}
          </div>
        ) : null}
      </ItemContent>
    </Item>
  )
}

/** A folding part of a card: its head — its title, a summary, the chevron
 *  at its end — over what it holds. */
export function PanelFold({
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
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn("min-w-0", className)}
      {...props}
    >
      <h3 className="min-w-0">
        <CollapsibleTrigger className="group/fold flex h-10 w-full min-w-0 items-center gap-2 px-3 text-start transition-colors outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset">
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
      <CollapsibleContent className="min-w-0 px-3 pb-3">
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}

/** A card of folding parts, a hairline between them. */
export function PanelFolds({
  className,
  children,
  ...props
}: ComponentProps<"div">) {
  return (
    <Card
      className={cn(
        SURFACE,
        "min-w-0 gap-0 divide-y divide-border/60 py-0 ring-0",
        className
      )}
      {...props}
    >
      {children}
    </Card>
  )
}

/** A folding card: one part of its own. */
export function PanelCard(props: ComponentProps<typeof PanelFold>) {
  return (
    <PanelFolds>
      <PanelFold {...props} />
    </PanelFolds>
  )
}
