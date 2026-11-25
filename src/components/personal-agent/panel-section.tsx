"use client"

/**
 * The pieces the personal agent's side panel is built of, the same in each
 * of its tabs:
 * - `PanelSection`: a part of a tab — its title centred on a dashed pill,
 *   how many it holds after it, an action at the head's end — over its
 *   body. `titleInCards`: a part that is only its groups' cards and whose
 *   title does nothing ("Today", the matters) has no head of its own — its
 *   title leads each group's bar, before the group's own name.
 * - `PanelGroup`: a folding group inside a part (who a matter waits on, a
 *   group of today): one card, its head a bar across its top — its marker,
 *   its name and count in its tone, the chevron at the end — its things
 *   under it, a hairline between them, and at its foot the way to show the
 *   rest. `titled`: a group that is a part of its own (the routines) — its
 *   name the part's title, and no head over it; `action` (the way to add
 *   one) on its bar before the chevron.
 * - `PanelBar`: the bar across a card's top (a group's, a day's of output,
 *   a window's on the workspace).
 * - `PanelStack`: things one under another — a card for each thing with
 *   buttons, a box or a task's strip; the plain ones rows, those next to
 *   one another one card with hairlines between them. `flush`: inside a
 *   card of its own (a group's, a day's), each flat on it, a hairline
 *   between them.
 * - `PanelList`: rows on one surface, a hairline between them (an inset
 *   grouped list): the morning brief's rows.
 * - `PanelItem`: one thing (shadcn's `Item`): what leads it, its title and
 *   when, where it stands and a quiet line under it, a box, notes, its
 *   buttons, and a › at its head's end that unfolds the rest of it at its
 *   foot; the whole of it opens what it is about when it opens anything.
 *   In a stack a card or a row, in a list a row; outside both — the
 *   morning brief's rows in its bubble — a soft card of its own.
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

import { Callout, type CalloutTone } from "./aux-parts/kit/callout"

/** The folding parts that start folded; every other one starts open. */
const FOLDED_AT_FIRST: ReadonlySet<string> = new Set([
  // What was done today, a line until opened (C2).
  "activity.done",
  "stats.agents",
  "stats.tokens",
  "stats.usage",
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
  "ws-msg-card rounded-2xl border border-border/70 bg-card"
const SURFACE = PANEL_SURFACE

/** The title of the part a group is in, when it leads the group's bar. */
const SectionTitleContext = createContext<ReactNode>(null)

export function PanelSection({
  title,
  count,
  action,
  titleInCards = false,
  className,
  children,
  ...props
}: {
  title: ReactNode
  /** How many it holds, after the title. */
  count?: number | null
  /** At the head's end: the way to add one. */
  action?: ReactNode
  /** No head: the title leads each of its groups' bars instead. */
  titleInCards?: boolean
  children: ReactNode
} & Omit<ComponentProps<"section">, "title">) {
  if (titleInCards) {
    return (
      <section
        className={cn("flex min-w-0 flex-col gap-4", className)}
        {...props}
      >
        {/* Still the part's heading to a screen reader: out of the flow. */}
        <h3 className="sr-only">{title}</h3>
        <SectionTitleContext value={title}>{children}</SectionTitleContext>
      </section>
    )
  }
  return (
    <section
      className={cn("flex min-w-0 flex-col gap-4", className)}
      {...props}
    >
      {/* The title and its count in the middle, on a dashed pill the size
          of a view's picker but with no fill — it picks nothing — the
          action at the end: the title stays centred whether or not there
          is one. */}
      <div className="grid h-8 min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,auto)_minmax(0,1fr)] items-center gap-1.5">
        <div className="col-start-2 flex h-8 min-w-0 items-center gap-1.5 rounded-full border border-dashed border-muted-foreground/35 px-3">
          <h3 className="min-w-0 truncate text-[0.9375rem] font-semibold text-foreground">
            {title}
          </h3>
          {count != null && count > 0 ? (
            <span className="shrink-0 text-[0.8125rem] text-muted-foreground tabular-nums">
              {count}
            </span>
          ) : null}
        </div>
        {action ? (
          <div className="col-start-3 -me-1 flex shrink-0 items-center justify-self-end">
            {action}
          </div>
        ) : null}
      </div>
      {children}
    </section>
  )
}

/** The bar across a card's top: what the card is, on a tint, a hairline
 *  under it. */
export const PANEL_BAR =
  "flex h-9 min-w-0 items-center gap-2 bg-muted/40 px-3 text-xs font-medium"

export function PanelBar({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(PANEL_BAR, "border-b border-border/60", className)}
      {...props}
    />
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
  | "red"

/** A tone's marker (its dot) and its words (the group's name and count). */
const TONE: Record<PanelTone, { dot: string; text: string }> = {
  amber: {
    dot: "bg-amber-500",
    text: "text-amber-700 dark:text-amber-300",
  },
  primary: { dot: "bg-primary", text: "text-primary" },
  violet: {
    dot: "bg-violet-500",
    text: "text-violet-700 dark:text-violet-300",
  },
  muted: { dot: "bg-muted-foreground/50", text: "text-muted-foreground" },
  faint: { dot: "bg-muted-foreground/30", text: "text-muted-foreground" },
  green: {
    dot: "bg-emerald-500",
    text: "text-emerald-700 dark:text-emerald-400",
  },
  red: { dot: "bg-red-500", text: "text-red-700 dark:text-red-400" },
}

export function PanelGroup({
  fold,
  tone,
  icon: Icon,
  label,
  count,
  titled = false,
  action,
  more,
  className,
  children,
  ...props
}: {
  /** Its key in the page's store. */
  fold: string
  tone: PanelTone
  /** Its marker, in place of the dot. */
  icon?: LucideIcon
  label: string
  count: number
  /** It is a part of the tab of its own (the routines): its name the
   *  part's title — in a part's title's weight and colour, as a part's
   *  title leads its groups' bars — and its heading to a screen reader. */
  titled?: boolean
  /** At the bar's end, before the chevron: the way to add one. */
  action?: ReactNode
  /** Under the list: the way to show the rest of it (`PanelMoreRow`). */
  more?: ReactNode
  /** Its rows: `PanelItem`s. */
  children: ReactNode
} & ComponentProps<"section">) {
  const [open, setOpen] = useFold(fold)
  const section = useContext(SectionTitleContext)
  const name = (
    <>
      {Icon ? (
        <Icon aria-hidden className="size-3.5 shrink-0" />
      ) : (
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full", TONE[tone].dot)}
        />
      )}
      {/* The part it is in first, then its own name. */}
      {section != null ? (
        <>
          <span
            className="shrink-0 font-semibold text-foreground"
            data-pa-group-section
          >
            {section}
          </span>
          <span aria-hidden className="shrink-0 text-muted-foreground/50">
            ·
          </span>
        </>
      ) : null}
      <span
        className={cn(
          "min-w-0 truncate",
          titled && "font-semibold text-foreground"
        )}
        data-pa-group-label
      >
        {label}
      </span>
      <span className="shrink-0 tabular-nums">{count}</span>
    </>
  )
  const chevron = (className?: string) => (
    <ChevronDown
      aria-hidden
      className={cn(
        "size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=closed]/fold:-rotate-90 rtl:group-data-[state=closed]/fold:rotate-90",
        className
      )}
    />
  )
  // A part of its own: its bar its heading to a screen reader too.
  const heading = (bar: ReactNode) =>
    titled ? <h3 className="flex min-w-0">{bar}</h3> : bar
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <section
        className={cn(
          PANEL_SURFACE,
          "flex min-w-0 flex-col overflow-hidden",
          className
        )}
        {...props}
      >
        {action ? (
          // A button of its own on the bar: the folding button its name,
          // stretched over the whole bar but that button, which sits over
          // it before the chevron; the bar deeper when the fold is hovered.
          <div
            className={cn(
              PANEL_BAR,
              "group/fold relative transition-colors has-[[data-pa-fold]:hover]:bg-muted",
              TONE[tone].text
            )}
            data-state={open ? "open" : "closed"}
          >
            {heading(
              <CollapsibleTrigger
                data-pa-fold
                className="flex min-w-0 items-center gap-2 text-start outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring/50 focus-visible:after:ring-inset"
              >
                {name}
              </CollapsibleTrigger>
            )}
            <span className="relative z-10 ms-auto -me-1 flex shrink-0 items-center">
              {action}
            </span>
            {chevron()}
          </div>
        ) : (
          // Its head the bar across its top, the whole of it the button
          // that folds it — deeper when hovered.
          heading(
            <CollapsibleTrigger
              data-pa-fold
              className={cn(
                PANEL_BAR,
                "group/fold w-full text-start transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset",
                TONE[tone].text
              )}
            >
              {name}
              {chevron("ms-auto")}
            </CollapsibleTrigger>
          )
        )}
        <CollapsibleContent className="flex min-w-0 flex-col border-t border-border/60">
          <PanelStack flush>{children}</PanelStack>
          {more ? (
            <div className="flex min-w-0 border-t border-border/50 px-4 py-1">
              {more}
            </div>
          ) : null}
        </CollapsibleContent>
      </section>
    </Collapsible>
  )
}

/** What an item sits on: a `PanelList`'s row, a `PanelStack`'s card or
 *  row, or nothing — a soft card of its own (the morning brief's). */
type Surface = "list" | "stack" | "flush" | null
const SurfaceContext = createContext<Surface>(null)

/** Whether the item being drawn is on the panel's lists or stacks: its lead
 *  a size up. */
export function useInPanelList(): boolean {
  return useContext(SurfaceContext) != null
}

/** A group's things one under another: each one with buttons, a box or a
 *  task's strip a card of its own; the plain ones in a row each, the rows
 *  next to one another drawn as one card with a hairline between them. */
export function PanelStack({
  flush = false,
  className,
  children,
  ...props
}: { flush?: boolean } & ComponentProps<"div">) {
  return (
    <SurfaceContext value={flush ? "flush" : "stack"}>
      <div
        role="list"
        className={cn("flex min-w-0 flex-col", !flush && "gap-4", className)}
        {...props}
      >
        {children}
      </div>
    </SurfaceContext>
  )
}

/** Rows on one surface, a hairline between them. */
export function PanelList({
  className,
  children,
  ...props
}: ComponentProps<"div">) {
  return (
    <SurfaceContext value="list">
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
    </SurfaceContext>
  )
}

/** Under a list, the way to show the rest of it: its words and a chevron,
 *  quiet until hovered. */
export function PanelMoreRow({ children, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className="-mx-1.5 inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-start text-xs font-medium text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      {...props}
    >
      {children}
      <ChevronDown className="size-3.5 shrink-0" aria-hidden />
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
        "flex min-w-0 items-center gap-2.5 rounded-2xl border border-dashed border-border px-3.5 py-3",
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
/** A stack's title: a weight up. */
const STACK_TITLE =
  "line-clamp-2 min-w-0 flex-1 text-sm leading-5 font-semibold break-words text-foreground"

/** In a stack, a row joins the row before it into one card: the gap
 *  between them closed, the corners and the edge where they meet gone, a
 *  hairline under the one above. */
const JOINED_ROW =
  "[[data-pa-shape=row]+&]:-mt-4 [[data-pa-shape=row]+&]:rounded-t-none [[data-pa-shape=row]+&]:border-t-0 has-[+[data-pa-shape=row]]:rounded-b-none has-[+[data-pa-shape=row]]:border-b-border/50"

export interface PanelItemProps extends Omit<ComponentProps<"div">, "title"> {
  /** What leads it: an avatar, a kind's icon. */
  media?: ReactNode
  title: ReactNode
  /** When, short: at the title's end on a list's row, after the quiet line
   *  on a stack's. */
  time?: ReactNode
  /** Its own controls at the title's end (a switch, a menu). */
  aside?: ReactNode
  /** Where it stands: leading the quiet line. */
  chip?: ReactNode
  /** A quiet line under the title. */
  meta?: ReactNode
  /** What it says, in a box of its tone (a stack's card); elsewhere a note. */
  callout?: { tone: CalloutTone; mono?: boolean; text: ReactNode } | null
  notes?: ReactNode[]
  onOpen?: (() => void) | null
  openLabel?: string
  /** Opening it opens it in place: whether it is (its button's
   *  `aria-expanded`). */
  expanded?: boolean
  /** More under it, before the buttons: a task's card (8.5). */
  extra?: ReactNode
  /** Buttons under it, apart from what opening it does: a card's row. */
  actions?: ReactNode
  /** One button at its end: a row keeps it there. */
  action?: ReactNode
  /** At its head's end, after everything there: the › that unfolds
   *  `details`. */
  unfold?: ReactNode
  /** What it unfolds to, at its foot — under its buttons, so nothing above
   *  it moves as it opens. */
  details?: ReactNode
}

export function PanelItem(props: PanelItemProps) {
  const surface = useContext(SurfaceContext)
  if (surface === "stack" || surface === "flush")
    return <StackItem {...props} flush={surface === "flush"} />
  return <ListItem {...props} inList={surface === "list"} />
}

/** The button over the whole of an item that opens it — its title — or the
 *  title alone. */
function ItemTitle({
  title,
  onOpen,
  openLabel,
  expanded,
  className,
  ring,
}: {
  title: ReactNode
  onOpen?: (() => void) | null
  openLabel?: string
  expanded?: boolean
  className: string
  ring: string
}) {
  if (!onOpen) return <span className={className}>{title}</span>
  return (
    // Its ::after covers the item: a click anywhere on it opens it, but on
    // its buttons, which sit over it.
    <button
      type="button"
      data-pa-item-open
      onClick={onOpen}
      title={openLabel}
      aria-expanded={expanded}
      className={cn(
        "flex min-w-0 flex-1 text-start outline-none after:absolute after:inset-0",
        ring
      )}
    >
      <span className={className}>{title}</span>
    </button>
  )
}

/** A stack's thing: a card with what it says, its strip and its buttons
 *  under its head; a row when it has none of them. One tree for both, its
 *  head where it is in either: a row that opens into a card in place keeps
 *  its button, and the focus on it. */
function StackItem({
  media,
  title,
  time,
  aside,
  chip,
  meta,
  callout,
  notes = [],
  onOpen,
  openLabel,
  expanded,
  extra,
  actions,
  action,
  unfold,
  details,
  flush,
  className,
  ...props
}: PanelItemProps & { flush: boolean }) {
  const card =
    actions != null || extra != null || callout != null || details != null
  // Its quiet line: what it is, then when.
  const line =
    meta != null || time != null ? (
      <>
        {meta}
        {meta != null && time != null ? " · " : null}
        {time != null ? <span className="tabular-nums">{time}</span> : null}
      </>
    ) : null
  const chipEl = chip ? (
    <span className="relative z-10 flex shrink-0 items-center">{chip}</span>
  ) : null
  const noteEls = notes.map((note, i) => (
    <ItemDescription
      key={i}
      className="text-start text-xs leading-[1.125rem] break-words"
    >
      {note}
    </ItemDescription>
  ))
  return (
    <Item
      role="listitem"
      data-pa-shape={card ? "card" : "row"}
      variant="outline"
      size="sm"
      className={cn(
        "relative flex-nowrap",
        flush
          ? // Flat on its card, a hairline under each but the last.
            "rounded-none border-x-0 border-t-0 border-b-border/50 bg-transparent last:border-b-0"
          : "ws-msg-card rounded-2xl border-border/70 bg-card",
        card
          ? "flex-col items-stretch gap-3 p-4"
          : cn("items-center px-4 py-3", !flush && JOINED_ROW),
        onOpen && "has-[[data-pa-item-open]:hover]:bg-muted/40",
        className
      )}
      {...props}
    >
      <div
        className={cn(
          "flex w-full min-w-0",
          card ? "items-start gap-2.5" : "items-center gap-3"
        )}
      >
        {media ? (
          <span className="flex shrink-0 self-start">{media}</span>
        ) : null}
        <ItemContent className="min-w-0 gap-0.5">
          <div className="flex min-w-0 items-start gap-2">
            <ItemTitle
              title={title}
              onOpen={onOpen}
              openLabel={openLabel}
              expanded={expanded}
              className={STACK_TITLE}
              ring={cn(
                "focus-visible:after:ring-2 focus-visible:after:ring-ring/50 focus-visible:after:ring-inset",
                !flush && "focus-visible:after:rounded-2xl"
              )}
            />
            {aside ? (
              <span className="relative z-10 -my-0.5 -me-1 flex shrink-0 items-center">
                {aside}
              </span>
            ) : null}
            {unfold ? (
              <span className="relative z-10 -my-0.5 -me-1.5 flex shrink-0 items-center">
                {unfold}
              </span>
            ) : null}
          </div>
          {/* Where it stands leads its quiet line: the title keeps the
              width of the card. */}
          {chipEl || line ? (
            <div className="flex min-w-0 items-center gap-1.5">
              {chipEl}
              {line ? (
                <ItemDescription
                  className={cn(
                    "min-w-0 text-start text-xs leading-5",
                    card ? "truncate" : "line-clamp-2"
                  )}
                >
                  {line}
                </ItemDescription>
              ) : null}
            </div>
          ) : null}
          {card ? null : noteEls}
        </ItemContent>
        {!card && action ? (
          <span className="relative z-10 flex shrink-0 items-center">
            {action}
          </span>
        ) : null}
      </div>
      {card && callout ? (
        <Callout tone={callout.tone} mono={callout.mono}>
          {callout.text}
        </Callout>
      ) : null}
      {card ? noteEls : null}
      {card && extra ? (
        <div className="relative z-10 min-w-0">{extra}</div>
      ) : null}
      {card && (actions || action) ? (
        <div className="relative z-10 flex flex-wrap items-center gap-2">
          {actions}
          {action}
        </div>
      ) : null}
      {details ? (
        <div className="relative z-10 min-w-0 border-t border-border/50 pt-3">
          {details}
        </div>
      ) : null}
    </Item>
  )
}

/** A list's row, or — outside any list — a soft card of its own. */
function ListItem({
  media,
  title,
  time,
  aside,
  chip,
  meta,
  callout,
  notes = [],
  onOpen,
  openLabel,
  expanded,
  extra,
  actions,
  action,
  unfold,
  details,
  inList,
  className,
  ...props
}: PanelItemProps & { inList: boolean }) {
  // No boxes here: what one says is a note.
  const allNotes = callout ? [callout.text, ...notes] : notes
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
          <ItemTitle
            title={title}
            onOpen={onOpen}
            openLabel={openLabel}
            expanded={expanded}
            className={TITLE}
            ring={
              inList
                ? "focus-visible:after:ring-2 focus-visible:after:ring-ring/50 focus-visible:after:ring-inset"
                : "after:rounded-2xl focus-visible:after:ring-[3px] focus-visible:after:ring-ring/50"
            }
          />
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
          {unfold ? (
            <span className="relative z-10 -my-0.5 -me-1 flex shrink-0 items-center">
              {unfold}
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
        {allNotes.map((note, i) => (
          <ItemDescription
            key={i}
            className="text-start text-xs leading-[1.125rem] break-words"
          >
            {note}
          </ItemDescription>
        ))}
        {extra ? <div className="relative z-10 min-w-0">{extra}</div> : null}
        {actions || action ? (
          <div className="relative z-10 mt-2 flex flex-wrap gap-1.5">
            {actions}
            {action}
          </div>
        ) : null}
        {details ? (
          <div className="relative z-10 mt-2 min-w-0">{details}</div>
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
