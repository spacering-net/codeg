"use client"

/**
 * The conversation with the personal agent: the owner's messages, the
 * assistant's replies, and the news about the work it handed out, oldest at
 * the top, in the chat column the conversations use (the same width as the
 * input box under it). It follows the newest while the reader is at the
 * bottom (a reply growing included) and holds still while they read back;
 * a message the owner sends takes them to the bottom wherever they were.
 * Only the reader's own scrolling takes it off the bottom. Its scrollbar is
 * the side panel's (OverlayScrollbars).
 *
 * A virtual list (virtua, as the conversations' thread): only the rows in
 * and near the view are drawn, so a long conversation scrolls and updates
 * as a short one does. A row is a message with the lines right over it; a
 * card waiting for the owner stays drawn wherever the view is, and so do
 * the rows near the end once the view is there. Older messages loaded in
 * keep the row the reader was looking at where it was. Opened, or another
 * assistant shown, it draws its newest rows alone until it is at its
 * bottom, then the rest above them (`TAIL_ROWS`), and comes in — a little
 * up into place when the chat view moves; a row is drawn again only when
 * it changes.
 *
 * What the assistants said is new to the owner until they see it: while
 * the list is at its bottom in a window that has focus, everything up to
 * the newest is marked seen as it lands. When they come to it — opening the
 * page, coming back to the window, scrolling back down — with something new
 * waiting, a "new messages" line goes above the first of it, and stays until
 * they leave the page or send a message, or the pointer has been over it.
 *
 * A jump to a message (a quote's click) scrolls it to the middle and flashes
 * it; one older than what is loaded is loaded first, and one too far back to
 * load opens as a preview instead. Each jump is numbered, so a slow load
 * answering after a newer jump never moves the page.
 *
 * Two pills float over it (10.7): "N items need you" while cards in it wait
 * for the owner (a click scrolls to the first), and "New messages" while the
 * reader is up the page and something came in under them (a click goes to
 * the bottom). Up the page with nothing new under them, the conversations'
 * own round button takes them down instead, shown when it would show there
 * (past `use-stick-to-bottom`'s slack), gliding when the chat view moves. A
 * message that comes in while the page is open rises into place; what was
 * there, or is loaded from further back, does not.
 */

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useTranslations } from "next-intl"
import { ArrowDown, BellRing, X } from "lucide-react"
import { toast } from "sonner"
import {
  Virtualizer,
  type CustomContainerComponentProps,
  type VirtualizerHandle,
} from "virtua"

import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { JsonRenderScope } from "@/components/ai-elements/json-render-pre"
import { MessageResponse } from "@/components/ai-elements/message"
import { rowsKeptNearEnd } from "@/components/message/virtualized-message-thread"
import { ScrollToLatestButton } from "@/components/ai-elements/message-thread"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { usePersonalAgent } from "@/contexts/personal-agent-context"
import { useChatMotion, useReducedMotion } from "@/hooks/use-chat-motion"
import { toErrorMessage } from "@/lib/app-error"
import type { TimelineRow } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useActivity } from "@/stores/personal-agent-activity-store"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"
import { EventCard } from "./event-card"
import { ExchangeRow } from "./exchange-row"
import { MirrorCard } from "./mirror-card"
import { NoticeCard } from "./notice-card"
import { BlockingPrompts } from "./live-turn"
import { useMessageTime } from "./message-actions"
import {
  buildMessageItems,
  isLine,
  itemRowIds,
  listRowsOf,
  newLineIndex,
  type ListRow as ItemRow,
  type MessageItem,
} from "./message-items"
import { MessageEnterContext, useEnterClass } from "./message-row"
import { OwnerBubble } from "./owner-bubble"
import { PaReplyScope } from "./pa-card-scope"
import { useQuoteAuthor, useQuotedRow } from "./quote-bar"
import { ReplyBubble, SaidBubble } from "./reply-bubble"
import { conclusionOf, turnTexts } from "./turn-texts"
import {
  afterScroll,
  farFromBottom,
  STICK_PX,
  USER_SCROLL_MS,
} from "./follow-bottom"
import {
  BUBBLE_MARKDOWN,
  MARKDOWN_LIST_ROOM,
  str,
  usePageScope,
} from "./shared"
import { useOwnerSeen } from "./use-owner-seen"

const FLASH_MS = 2000

/** Whether the window shows the page to someone: visible, and focused. */
function windowAttended(): boolean {
  if (typeof document === "undefined") return false
  return document.visibilityState === "visible" && document.hasFocus()
}

function useWindowAttended(): boolean {
  const [attended, setAttended] = useState(windowAttended)
  useEffect(() => {
    const update = () => setAttended(windowAttended())
    window.addEventListener("focus", update)
    window.addEventListener("blur", update)
    document.addEventListener("visibilitychange", update)
    update()
    return () => {
      window.removeEventListener("focus", update)
      window.removeEventListener("blur", update)
      document.removeEventListener("visibilitychange", update)
    }
  }, [])
  return attended
}

/**
 * A line across the list with a word in its middle, as the conversation
 * marks a compaction: hairlines fading out toward the edges. As much room
 * over it as under it (the message under it adds none), so it sits in the
 * middle of the gap between two messages; none over the list's first.
 */
function ListDivider({
  tone,
  divider = true,
  className,
  children,
  ...rest
}: {
  tone?: "new"
  /** Still a line the message under it takes its room from (`false` while
   *  one folds away). */
  divider?: boolean
  className?: string
  children: React.ReactNode
} & Omit<React.ComponentProps<"div">, "children">) {
  const enter = useEnterClass()
  const hairline = cn(
    "flex-1 bg-transparent from-transparent",
    tone === "new" ? "to-primary/40" : "to-border/70"
  )
  return (
    <div
      {...rest}
      data-pa-divider={divider || undefined}
      className={cn(
        "flex items-center gap-3 py-3 text-xs select-none [[data-pa-row-first]>&:first-child]:pt-0",
        tone === "new" ? "text-primary" : "text-muted-foreground/80",
        enter,
        className
      )}
    >
      <Separator
        className={cn(hairline, "bg-gradient-to-r rtl:bg-gradient-to-l")}
      />
      <span className="shrink-0">{children}</span>
      <Separator
        className={cn(hairline, "bg-gradient-to-l rtl:bg-gradient-to-r")}
      />
    </div>
  )
}

/** How long after the pointer came over the "new messages" line it goes,
 *  then how long it fades and how long the room it took closes. */
const NEW_LINE_HOVER_MS = 600
const NEW_LINE_FADE_MS = 200
const NEW_LINE_FOLD_MS = 200

/**
 * The "new messages" line: it stays until the owner leaves the page or
 * sends a message — or until the pointer has been over it, when it fades
 * and the room it took closes, the message under it gliding up to where it
 * then sits.
 */
export function NewLine({ onSeen }: { onSeen: () => void }) {
  const t = useTranslations("PersonalAgent.timeline")
  const reduced = useReducedMotion()
  const ref = useRef<HTMLDivElement | null>(null)
  const [phase, setPhase] = useState<"shown" | "fading" | "folding">("shown")
  const timer = useRef<number | null>(null)
  // Its height as it began to fold, padding included.
  const height = useRef(0)
  const seen = useRef(onSeen)
  useEffect(() => {
    seen.current = onSeen
  })
  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current)
    },
    []
  )
  useEffect(() => {
    if (phase !== "fading") return
    const id = window.setTimeout(() => {
      height.current = ref.current?.offsetHeight ?? 0
      setPhase("folding")
    }, NEW_LINE_FADE_MS)
    return () => window.clearTimeout(id)
  }, [phase])
  // No longer a line, the message under it takes its own room: the line
  // closes from its height less that room to nothing, so what is under it
  // moves smoothly to its place.
  useLayoutEffect(() => {
    if (phase !== "folding") return
    const el = ref.current
    if (!el || typeof el.animate !== "function") {
      seen.current()
      return
    }
    const next = el.nextElementSibling
    const room = next ? Number.parseFloat(getComputedStyle(next).marginTop) : 0
    const from = Math.max(
      0,
      height.current - (Number.isFinite(room) ? room : 0)
    )
    const motion = el.animate([{ height: `${from}px` }, { height: "0px" }], {
      duration: NEW_LINE_FOLD_MS,
      easing: "ease-out",
      fill: "forwards",
    })
    motion.onfinish = () => seen.current()
    return () => motion.cancel()
  }, [phase])
  return (
    <ListDivider
      ref={ref}
      tone="new"
      divider={phase !== "folding"}
      data-pa-new={phase}
      onPointerEnter={() => {
        if (phase !== "shown" || timer.current != null) return
        timer.current = window.setTimeout(() => {
          timer.current = null
          if (reduced) seen.current()
          else setPhase("fading")
        }, NEW_LINE_HOVER_MS)
      }}
      className={cn(
        "transition-opacity",
        phase !== "shown" && "opacity-0",
        phase === "folding" && "overflow-hidden py-0"
      )}
      style={{ transitionDuration: `${NEW_LINE_FADE_MS}ms` }}
    >
      {t("newMessages")}
    </ListDivider>
  )
}

function TimeLine({ at }: { at: string }) {
  const time = useMessageTime()
  return (
    <ListDivider data-pa-time>
      <span className="tabular-nums">{time(at)}</span>
    </ListDivider>
  )
}

/** The row an item stands at, for one drawn as a row. */
function rowIdOf(item: MessageItem): number | null {
  if (item.kind === "time") return null
  if (item.kind === "reply") return item.anchor.id
  return item.row.id
}

/** The "N items need you" pill: on the primary, what waits on the owner
 *  anywhere ("today"'s, `todayNeeds`, from the activity's read), opening
 *  the activity at the first of it (C6); otherwise — or with nothing there
 *  — the cards waiting in this conversation, scrolled to. `null`: no
 *  pill. */
export function attentionPill(
  todayNeeds: number,
  waits: number
): { count: number; today: boolean } | null {
  if (todayNeeds > 0) return { count: todayNeeds, today: true }
  if (waits > 0) return { count: waits, today: false }
  return null
}

/** What the pill stands for, each by a key of its own: "today"'s rows, or
 *  the cards here. */
export function attentionKeys(
  pill: { count: number; today: boolean } | null,
  todayKeys: readonly string[],
  waits: readonly number[]
): string[] {
  if (pill == null) return []
  if (!pill.today) return waits.map((id) => `row:${id}`)
  // A count with no rows read for it yet: the count stands for them.
  return todayKeys.length > 0 ? [...todayKeys] : [`count:${pill.count}`]
}

/** Whether the pill shows: not when the owner closed it while all it now
 *  stands for already needed them — again once one more does. */
export function attentionShown(
  keys: readonly string[],
  dismissed: readonly string[] | undefined
): boolean {
  if (keys.length === 0) return false
  if (dismissed == null) return true
  const seen = new Set(dismissed)
  return keys.some((k) => !seen.has(k))
}

/** A card waiting for the owner: a question or permission request still
 *  pending, a native card still open that asks them (a confirmation, a step
 *  not known to have happened, a loop stopped, the opening choice, a change
 *  shown first, a reminder that came due — not a suggestion), an
 *  executor's question forwarded to them. */

export function waitsForOwner(row: TimelineRow): boolean {
  const data = row.data
  if (row.kind === "question" || row.kind === "permission") {
    return data?.state === "pending"
  }
  // An executor's question or plan approval, once it is the owner's.
  if (row.kind === "notice" && data?.notice === "ask") {
    return data?.state === "forwarded"
  }
  // A round of acceptance that is the owner's call, or theirs to check
  // again (7.5).
  if (row.kind === "notice" && data?.notice === "acceptance") {
    return data?.state === "open" || data?.state === "changed"
  }
  // Something on a forge to approve, or one in doubt (7.4).
  if (row.kind === "notice" && data?.notice === "forge") {
    return (
      (data?.state === "open" && data?.why !== "suggest") ||
      data?.state === "unknown"
    )
  }
  // A watched pull request the owner can merge now (7.4), one they are
  // asked about (have its task fix it, hand it the feedback), or one codeg
  // fixed as often as allowed.
  if (row.kind === "notice" && data?.notice === "pr") {
    const fix = data?.fix as { state?: string } | undefined
    return (
      data?.state === "open" &&
      (data?.event === "mergeable" ||
        data?.event === "feedback" ||
        fix?.state === "ask" ||
        fix?.state === "gave_up")
    )
  }
  // A plan the owner is to start, one with a step for them to confirm, or
  // one stuck on a step (7.6).
  if (row.kind === "notice" && data?.notice === "plan") {
    const plan = data?.plan as
      | {
          state?: string
          steps?: { state?: string; ready?: boolean; confirmed?: boolean }[]
        }
      | undefined
    return (
      plan?.state === "draft" ||
      plan?.state === "stuck" ||
      (plan?.state === "running" &&
        (plan.steps ?? []).some(
          (s) => s.state === "pending" && s.ready && !s.confirmed
        ))
    )
  }
  if (row.kind !== "notice" || data?.state !== "open") return false
  if (data?.why === "suggest") return false
  const kind = data?.notice
  return (
    kind === "proposal" ||
    kind === "uncertain" ||
    kind === "loop" ||
    kind === "choice" ||
    kind === "changed" ||
    (kind === "reminder" && data?.at_due !== "act")
  )
}

/** Where each card waiting for the owner is drawn, in order: a reply's
 *  question is in its bubble. Not an acceptance card nothing can be done
 *  on any more (`stale`, C6): its card still reads open, but the board has
 *  moved on — the pill would lead to a card that does nothing. */
export function ownerWaitTargets(
  items: readonly MessageItem[],
  stale: ReadonlySet<number> = new Set()
): number[] {
  const waits = (row: TimelineRow) => !stale.has(row.id) && waitsForOwner(row)
  const out: number[] = []
  for (const item of items) {
    if (item.kind === "reply") {
      if (item.attached.some(waits)) out.push(item.anchor.id)
    } else if (
      (item.kind === "notice" || item.kind === "mirror") &&
      waits(item.row)
    ) {
      out.push(item.row.id)
    }
  }
  return out
}

/** A pill over the list: in and out by the motion tokens. */
function Pill({
  shown,
  className,
  label,
  onClick,
  onDismiss,
  dismissLabel,
  children,
  ...rest
}: {
  shown: boolean
  className?: string
  /** Its name, for a pill of an icon alone. */
  label?: string
  onClick: () => void
  /** An × at its end that closes it: two buttons on one pill. */
  onDismiss?: () => void
  dismissLabel?: string
  children: React.ReactNode
} & Record<`data-${string}`, string | boolean>) {
  const look =
    "motion-pill pointer-events-auto absolute start-1/2 z-10 flex -translate-x-1/2 items-center rounded-full border border-border bg-background/95 text-xs shadow-md backdrop-blur rtl:translate-x-1/2"
  const state = {
    "data-state": shown ? "open" : "closed",
    "aria-hidden": !shown || undefined,
  }
  const tabIndex = shown ? 0 : -1
  if (!onDismiss) {
    return (
      <button
        type="button"
        {...rest}
        {...state}
        aria-label={label}
        title={label}
        tabIndex={tabIndex}
        onClick={onClick}
        className={cn(
          look,
          "gap-1.5 px-3 py-1 transition-colors hover:bg-muted",
          className
        )}
      >
        {children}
      </button>
    )
  }
  return (
    <div
      {...rest}
      {...state}
      className={cn(look, "overflow-hidden", className)}
    >
      <button
        type="button"
        aria-label={label}
        title={label}
        tabIndex={tabIndex}
        onClick={onClick}
        className="flex items-center gap-1.5 py-1 ps-3 pe-2 transition-colors outline-none hover:bg-muted focus-visible:bg-muted"
        data-pa-pill-open
      >
        {children}
      </button>
      <span aria-hidden className="h-3.5 w-px shrink-0 bg-border" />
      <button
        type="button"
        aria-label={dismissLabel}
        title={dismissLabel}
        tabIndex={tabIndex}
        onClick={onDismiss}
        className="flex items-center self-stretch ps-1.5 pe-2 text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:bg-muted"
        data-pa-pill-dismiss
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  )
}

/**
 * One row virtua draws: a column, as the list was — a message's room over
 * it is its own; one right under a line takes none (`data-pa-under-line`,
 * or the "new messages" line beside it in its row). Drawn again only when
 * its row is: the list's own state (shown, following, the way down) moves
 * nothing in it.
 */
const RowView = memo(function RowView({
  row,
  enters,
  onSeen,
}: {
  row: ListRow
  enters: boolean
  onSeen: () => void
}) {
  return (
    <div
      data-pa-row={row.key}
      data-pa-row-first={row.first || undefined}
      data-pa-under-line={row.underLine || undefined}
      className={cn("flex min-w-0 flex-col", row.first && "pt-4")}
    >
      {row.newLine ? <NewLine onSeen={onSeen} /> : null}
      {/* What came in rises into place on its own element (see
          MessageEnterContext). */}
      <MessageEnterContext.Provider value={enters}>
        <Item item={row.item} />
      </MessageEnterContext.Provider>
    </div>
  )
})

function Item({ item }: { item: MessageItem }) {
  switch (item.kind) {
    case "time":
      return <TimeLine at={item.at} />
    case "owner":
      return <OwnerBubble item={item} />
    case "reply":
      return <ReplyBubble item={item} />
    case "event":
      return <EventCard item={item} />
    case "notice":
      return <NoticeCard item={item} />
    case "exchange":
      return <ExchangeRow item={item} />
    case "said":
      return <SaidBubble item={item} />
    case "mirror":
      return <MirrorCard item={item} />
  }
}

/** A message too far back to load around: shown on its own. */
function PreviewDialog({
  rowId,
  onOpenChange,
}: {
  rowId: number | null
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslations("PersonalAgent.quote")
  return (
    <Dialog open={rowId != null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        {rowId != null ? <PreviewBody rowId={rowId} /> : null}
        <DialogDescription className="sr-only">
          {t("previewHint")}
        </DialogDescription>
      </DialogContent>
    </Dialog>
  )
}

function PreviewBody({ rowId }: { rowId: number }) {
  const t = useTranslations("PersonalAgent.quote")
  const row = useQuotedRow(rowId)
  const author = useQuoteAuthor()
  const time = useMessageTime()
  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-sm">
          {row ? `${author(row)} · ${time(row.created_at)}` : t("preview")}
        </DialogTitle>
      </DialogHeader>
      {row === undefined ? (
        <div className="h-24 rounded-lg bg-foreground/5 motion-safe:animate-pulse" />
      ) : row === null ? (
        <p className="text-sm text-muted-foreground">{t("unavailable")}</p>
      ) : (
        <ScrollArea className="max-h-[60vh] text-sm">
          {row.kind === "reply" ? (
            <PreviewTurn row={row} />
          ) : (
            <JsonRenderScope>
              <MessageResponse
                className={cn(MARKDOWN_LIST_ROOM, BUBBLE_MARKDOWN)}
              >
                {row.kind === "result"
                  ? [
                      str(row.data, "title"),
                      str(row.data, "excerpt") ?? row.body,
                    ]
                      .filter(Boolean)
                      .join("\n\n")
                  : row.body || t("noText")}
              </MessageResponse>
            </JsonRenderScope>
          )}
        </ScrollArea>
      )}
    </>
  )
}

/** A reply far back, whole: every run its turn said (as the list draws
 *  them, `turnTexts` — a row from before runs were kept, its body alone:
 *  its lines are not read here), what it said on the way drawn only. */
function PreviewTurn({ row }: { row: TimelineRow }) {
  const t = useTranslations("PersonalAgent.quote")
  const texts = turnTexts(row, undefined, [])
  const conclusion = conclusionOf(row)
  if (texts.length === 0) {
    return <p className="text-muted-foreground">{t("noText")}</p>
  }
  return (
    <div className="flex flex-col gap-2">
      {texts.map((run) => {
        const text = (
          <MessageResponse className={cn(MARKDOWN_LIST_ROOM, BUBBLE_MARKDOWN)}>
            {run.text}
          </MessageResponse>
        )
        return (
          <div key={run.n} data-pa-run={run.n}>
            {run.n === conclusion ? (
              <JsonRenderScope>{text}</JsonRenderScope>
            ) : (
              <PaReplyScope row={row} running={false} readOnly>
                {text}
              </PaReplyScope>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** Room (px) over and under the view in which rows stay drawn. */
const BUFFER_PX = 1000
/** How long what came in takes to rise into place — a split reply's
 *  bubbles one after another — after which it is drawn as what was there:
 *  drawn again (scrolled away and back) it does not rise again. */
const ENTER_SETTLE_MS = 1500
/** How long after older messages came in the row the reader was looking
 *  at is kept where it was. */
const KEEP_PLACE_MS = 1000
/** How many frames a jump waits for its row to be drawn, and for the
 *  message's own element in it before it takes the row's. */
const JUMP_OWN_FRAMES = 10
const JUMP_FRAMES = 90
/** How long a jump's message is held in the middle once drawn. */
const JUMP_HOLD_MS = 1000
/** Room (px) over a jump's message taller than the view. */
const JUMP_EDGE_PX = 16
/** Opened, or another assistant shown: the rows drawn at first, the newest
 *  — enough to fill the view and the room drawn round it. virtua starts at
 *  the top with rows it has not measured, so with the whole page it would
 *  draw most of it on the way to the bottom; the rest come in above once
 *  the list is there, as older ones do. */
const TAIL_ROWS = 16

/** A jump's message in the list: its own element, or — `row`: one drawn
 *  without its id (a card inside a turn's bubble) — its row's. */
function jumpTarget(
  root: HTMLElement,
  held: { id: number; key: string },
  row: boolean
): HTMLElement | null {
  const own = root.querySelector<HTMLElement>(`[data-row-id="${held.id}"]`)
  if (own || !row) return own
  for (const el of root.querySelectorAll<HTMLElement>("[data-pa-row]")) {
    if (el.dataset.paRow === held.key) return el
  }
  return null
}

/** A row of the list as virtua draws it: one item (`ItemRow`), the first
 *  of the conversation without the room over it the way to older ones
 *  leaves. */
type ListRow = ItemRow & { first: boolean }

/**
 * virtua's container, without the `pointer-events: none` it puts on it while
 * the list scrolls: the property is inherited, so turning it on and off
 * restyles everything drawn, and what it buys — rows under the pointer
 * taking no hover while the list moves — any page does without (as the
 * conversations' thread).
 */
function ListContainer({
  style,
  children,
  ref,
}: CustomContainerComponentProps) {
  return (
    <div
      ref={ref}
      style={{ ...style, pointerEvents: undefined }}
      // Each row virtua draws is a layer of its own (`contain: layout`),
      // the next one over the one before: the row under the pointer, or
      // with the focus in it, goes over the rest — the actions a message
      // floats over the row below it are under the pointer then, not that
      // row.
      className="[&>*:focus-within]:z-10 [&>*:hover]:z-10"
    >
      {children}
    </div>
  )
}

export function MessageList({
  jumpRef,
  sentRef,
}: {
  /** Where the list publishes its jump, for the page's scope. */
  jumpRef: React.RefObject<((rowId: number) => void) | null>
  /** Where it publishes what to do once the owner sent a message. */
  sentRef: React.RefObject<(() => void) | null>
}) {
  const t = useTranslations("PersonalAgent.timeline")
  const tp = useTranslations("PersonalAgent.pills")
  const scope = usePageScope()
  const {
    botId,
    rows,
    hasOlder,
    loadOlder,
    loadSince,
    snapshot,
    dispatchById,
  } = usePersonalAgent()
  const reduced = useReducedMotion()
  // A glide down when the chat view moves (as a conversation's does).
  const motion = useChatMotion()
  // The work queued or running now: its newest pill stays (P6.3 5) — the
  // items built again only when that set changes, not on every read.
  const liveKey = useMemo(
    () =>
      [...dispatchById.values()]
        .filter((d) => d.state === "queued" || d.state === "running")
        .map((d) => d.id)
        .sort((a, b) => a - b)
        .join(","),
    [dispatchById]
  )
  const liveWork = useMemo(
    () => new Set(liveKey ? liveKey.split(",").map(Number) : []),
    [liveKey]
  )
  const items = useMemo(
    () => buildMessageItems(rows, liveWork),
    [rows, liveWork]
  )
  const rowsById = scope.rowsById

  // The OverlayScrollbars viewport: it initializes a few frames after
  // mount, so everything that scrolls waits for it. The list keeps the view
  // still itself as rows above it change size (virtua): the browser's own
  // anchoring would move it twice.
  const scrollRef = useRef<HTMLElement | null>(null)
  const [scrollReady, setScrollReady] = useState(false)
  const onViewport = useCallback((el: HTMLElement | null) => {
    if (el) el.style.overflowAnchor = "none"
    scrollRef.current = el
    setScrollReady(el != null)
  }, [])
  const listRef = useRef<VirtualizerHandle | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const atBottom = useRef(true)
  // Where the list last was, for telling the reader's scroll up from the
  // list's own moves: put at its bottom while it was still short (rows not
  // yet measured), its scroll event comes once it has grown — not a move
  // up from where it was before.
  const lastTop = useRef(0)
  // When the reader last scrolled themselves, and whether a glide to the
  // bottom they asked for is under way (see `afterScroll`).
  const userAt = useRef(-Infinity)
  const gliding = useRef(false)
  // Older messages loading in above: the messages the reader was looking at
  // and where they were in the view, put back there as the rows over them
  // are drawn and measured — virtua keeps the view only near where it was
  // (it counts the new rows' heights before it has them, the way to older
  // ones goes with the last of them, the time line heading what was the
  // first can go, a run of lines between assistants can take in older
  // ones). By the first of them still drawn under its key; kept until a
  // moment after they came in, or until the reader scrolls.
  const keepAt = useRef<{
    rows: { key: string; top: number }[]
    /** When it was asked for: the reader's input after it leaves it. */
    since: number
    until: number
  } | null>(null)
  const keepPlace = useCallback(() => {
    const held = keepAt.current
    const root = scrollRef.current
    if (!held || !root) return
    if (performance.now() > held.until) {
      keepAt.current = null
      return
    }
    const drawn = new Map<string, HTMLElement>()
    for (const el of root.querySelectorAll<HTMLElement>("[data-pa-row]")) {
      drawn.set(el.dataset.paRow ?? "", el)
    }
    for (const kept of held.rows) {
      const row = drawn.get(kept.key)
      if (!row) continue
      const off =
        row.getBoundingClientRect().top - root.getBoundingClientRect().top
      if (Math.abs(off - kept.top) < 1) return
      root.scrollTop += off - kept.top
      lastTop.current = root.scrollTop
      return
    }
  }, [])
  // A jump's message, held in the middle of the view as the rows round it
  // are drawn and measured: for a moment once it is drawn, or until the
  // reader scrolls.
  const jumpHold = useRef<{
    id: number
    /** Its row's, for a message drawn without its own id. */
    key: string
    since: number
    until: number
  } | null>(null)
  const holdJump = useCallback(() => {
    const held = jumpHold.current
    const root = scrollRef.current
    if (!held || !root) return
    if (performance.now() > held.until) {
      jumpHold.current = null
      return
    }
    const target = jumpTarget(root, held, true)
    if (!target) return
    const view = root.getBoundingClientRect()
    const box = target.getBoundingClientRect()
    // Its middle in the view's, or — taller than the view — its top a
    // little under the view's.
    const want =
      box.height > view.height - 2 * JUMP_EDGE_PX
        ? view.top + JUMP_EDGE_PX
        : view.top + (view.height - box.height) / 2
    if (Math.abs(box.top - want) < 1) return
    root.scrollTop += box.top - want
    lastTop.current = root.scrollTop
  }, [])
  const frameRef = useRef<HTMLDivElement | null>(null)
  const toEnd = useCallback((el: HTMLElement) => {
    el.scrollTop = el.scrollHeight
    lastTop.current = el.scrollTop
  }, [])
  // The same, for what renders on it.
  const [bottomed, setBottomed] = useState(true)
  // Away from the bottom (`farFromBottom`): the way back down shows.
  const [far, setFar] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [preview, setPreview] = useState<number | null>(null)
  // Shown once the list has been put at its bottom: it draws the rows near
  // where it is, so it is put there over a few frames as they are measured,
  // the oldest never flashing by first.
  const [settled, setSettled] = useState(false)
  const jumpSeq = useRef(0)
  // Bumped when another assistant is shown: what was under way for the last
  // one (a jump, loading older) lands nowhere.
  const shownSeq = useRef(0)

  // Another assistant shown in this same list (the page keeps its frame
  // when switching): it opens at its bottom, as a list just opened does,
  // with nothing of the last one's left over — in the render that first
  // draws it, and scrolled there before it paints.
  // Its newest rows alone until it is at its bottom (`TAIL_ROWS`): from
  // the row picked when it opened (`tailKey`), so rows coming in at the end
  // meanwhile only add to it.
  const [tailOnly, setTailOnly] = useState(true)
  const [tailKey, setTailKey] = useState<string | null>(null)
  const [shownBot, setShownBot] = useState(botId)
  if (shownBot !== botId) {
    setShownBot(botId)
    setBottomed(true)
    setFar(false)
    setPreview(null)
    setLoadingOlder(false)
    setSettled(false)
    setTailOnly(true)
    setTailKey(null)
  }
  const scrolledFor = useRef(botId)
  useLayoutEffect(() => {
    if (scrolledFor.current === botId) return
    scrolledFor.current = botId
    shownSeq.current += 1
    jumpSeq.current += 1
    jumpHold.current = null
    keepAt.current = null
    atBottom.current = true
    const el = scrollRef.current
    if (el) toEnd(el)
  }, [botId, toEnd])

  // Follow what comes in — a new row, a reply growing, a step's height
  // animating — while the reader is at the bottom. Content changes size
  // without React re-rendering it (a transition), so watch the size itself.
  useEffect(() => {
    const el = scrollRef.current
    const content = contentRef.current
    if (!el || !content || typeof ResizeObserver === "undefined") return
    const measure = () =>
      setFar(
        farFromBottom({
          following: atBottom.current,
          gap: el.scrollHeight - el.scrollTop - el.clientHeight,
        })
      )
    const follow = () => {
      if (atBottom.current) toEnd(el)
      else {
        keepPlace()
        holdJump()
        // What came in under a reader up the page puts them further up.
        measure()
      }
    }
    lastTop.current = el.scrollTop
    // The reader's own input, on the list or its bar: what scrolls next is
    // theirs.
    const frame = frameRef.current
    const input = (e: Event) => {
      if (e.type === "pointermove" && (e as PointerEvent).buttons === 0) return
      userAt.current = performance.now()
    }
    const inputs = [
      "wheel",
      "touchstart",
      "touchmove",
      "pointerdown",
      "pointermove",
      "keydown",
    ] as const
    for (const type of inputs) {
      frame?.addEventListener(type, input, { passive: true, capture: true })
    }
    const onScroll = () => {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight
      const user = performance.now() - userAt.current < USER_SCROLL_MS
      // The reader moved on: the place kept for them, or the message they
      // jumped to, is theirs to leave.
      if (keepAt.current && userAt.current > keepAt.current.since) {
        keepAt.current = null
      } else keepPlace()
      if (jumpHold.current && userAt.current > jumpHold.current.since) {
        jumpHold.current = null
      } else holdJump()
      const next = afterScroll({
        was: atBottom.current,
        gap,
        top: el.scrollTop,
        lastTop: lastTop.current,
        user,
        gliding: gliding.current,
      })
      if (gap < STICK_PX) gliding.current = false
      atBottom.current = next.following
      if (next.restick) toEnd(el)
      lastTop.current = el.scrollTop
      setBottomed(atBottom.current)
      measure()
    }
    const ro = new ResizeObserver(follow)
    ro.observe(content)
    follow()
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      ro.disconnect()
      el.removeEventListener("scroll", onScroll)
      for (const type of inputs) {
        frame?.removeEventListener(type, input, { capture: true })
      }
    }
  }, [scrollReady, toEnd, keepPlace, holdJump])

  // Put at its bottom a few frames running — the rows there drawn and
  // measured in between — before it shows: its newest rows first, then
  // (the rest drawn in above, `shift`) a couple more frames.
  const tailingRef = useRef(false)
  useEffect(() => {
    if (!scrollReady || settled) return
    let frames = 0
    let raf = 0
    const step = () => {
      const el = scrollRef.current
      if (el && atBottom.current) toEnd(el)
      frames += 1
      if (frames < 2) raf = requestAnimationFrame(step)
      else {
        setTailOnly(false)
        if (!tailingRef.current) setSettled(true)
      }
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [scrollReady, settled, botId, toEnd, tailOnly])

  const flash = useCallback(
    (el: HTMLElement) => {
      const cls = reduced ? "pa-flash-static" : "pa-flash"
      el.classList.remove("pa-flash", "pa-flash-static", "motion-jump-ring")
      // Restart the animation on a second jump to the same row.
      void el.offsetWidth
      // The highlight, and a ring flashing once round it (10.7).
      el.classList.add(cls, "motion-jump-ring")
      window.setTimeout(
        () => el.classList.remove(cls, "motion-jump-ring"),
        FLASH_MS + 100
      )
    },
    [reduced]
  )

  // ── what is new to the owner ────────────────────────────────────────────
  const attended = useWindowAttended()
  const watching = scrollReady && bottomed && attended
  const setWatching = usePersonalAgentUi((s) => s.setWatching)
  useEffect(() => {
    setWatching(watching)
  }, [watching, setWatching])
  useEffect(() => () => setWatching(false), [setWatching])

  const { newFrom, clearNewFrom } = useOwnerSeen({
    rows,
    watching,
    unseenCount: snapshot?.status.unseen ?? 0,
  })

  // The owner sent a message: to the bottom, to see it land, and following
  // from there; what was new is behind them now. Asked for from the way
  // down (the pill, the button), it glides there, motion allowed.
  const toBottom = useCallback(
    (glide = false) => {
      clearNewFrom()
      const el = scrollRef.current
      if (!el) return
      jumpHold.current = null
      keepAt.current = null
      atBottom.current = true
      setBottomed(true)
      setFar(false)
      if (glide && motion) {
        gliding.current = true
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
      } else toEnd(el)
    },
    [clearNewFrom, motion, toEnd]
  )
  useEffect(() => {
    sentRef.current = () => toBottom()
  }, [sentRef, toBottom])
  const newLineAt = newFrom != null ? newLineIndex(items, newFrom) : -1

  // ── what rises into place, and the pills ────────────────────────────────
  // Not what folds into a work's head (A4): that head is where it shows,
  // as a card that moves on in place — not "new below".
  const lastId = useMemo(() => {
    let max = 0
    for (const item of items) max = Math.max(max, rowIdOf(item) ?? 0)
    return max
  }, [items])
  // Rows past the last one held when the page showed this assistant came
  // in while it was open — by their item, so one that was there and only
  // moved (a reply's bubble taking its own row) does not.
  const [enterFrom, setEnterFrom] = useState<{
    bot: number | null
    id: number
    keys: ReadonlySet<string>
  } | null>(null)
  if (scrollReady && (enterFrom == null || enterFrom.bot !== botId)) {
    setEnterFrom({
      bot: botId,
      id: lastId,
      keys: new Set(items.map((i) => i.key)),
    })
  }
  const enters = (item: MessageItem) => {
    const id = rowIdOf(item)
    return (
      // A part of a turn was there already, in its reply's bubble, when
      // the line that cut it off came: it does not rise.
      item.kind !== "said" &&
      enterFrom != null &&
      enterFrom.bot === botId &&
      !enterFrom.keys.has(item.key) &&
      id != null &&
      id > enterFrom.id
    )
  }
  // Once what came in has risen, it is what was there: a row scrolled away
  // and drawn again does not rise again.
  const entering = items
    .filter(enters)
    .map((i) => i.key)
    .join(" ")
  const settleWith = useRef({ items, lastId })
  useEffect(() => {
    settleWith.current = { items, lastId }
  })
  useEffect(() => {
    if (!entering) return
    const id = window.setTimeout(() => {
      const { items: now, lastId: last } = settleWith.current
      setEnterFrom({
        bot: botId,
        id: last,
        keys: new Set(now.map((i) => i.key)),
      })
    }, ENTER_SETTLE_MS)
    return () => window.clearTimeout(id)
  }, [entering, botId])
  // Up the page when something came in under the reader.
  const [leftAt, setLeftAt] = useState<number | null>(null)
  if (bottomed && leftAt != null) setLeftAt(null)
  else if (!bottomed && leftAt == null) setLeftAt(lastId)
  const newBelow = leftAt != null && lastId > leftAt
  // The page's activity, read once for the list, the badge and this.
  const activity = useActivity(botId)
  const stale = useMemo(
    () => new Set(activity?.stale_acceptance ?? []),
    [activity]
  )
  const waits = useMemo(() => ownerWaitTargets(items, stale), [items, stale])
  // On the primary the pill counts what waits on the owner anywhere —
  // "today"'s, from the same read as the list — and opens the activity at
  // the first of it (10.7, C6); elsewhere, or with none, the cards here,
  // scrolled to.
  const pill = attentionPill(
    botId == null ? (activity?.pill.count ?? 0) : 0,
    waits.length
  )
  const showWaiting = usePersonalAgentUi((s) => s.showWaiting)
  // Closed by the owner: hidden until something new needs them.
  const conversation = botId == null ? "primary" : String(botId)
  const pillKeys = attentionKeys(
    pill,
    (activity?.needs ?? []).map((r) => r.key),
    waits
  )
  const dismissed = usePersonalAgentUi(
    (s) => s.attentionDismissed[conversation]
  )
  const dismissAttention = usePersonalAgentUi((s) => s.dismissAttention)
  const pillShown = attentionShown(pillKeys, dismissed)
  // The message right above the "new messages" line is the last before a
  // line, as one above a time line is: it closes its run with a round
  // corner, and shows its actions on hover.
  const placed = useMemo(() => {
    const above = items[newLineAt - 1]
    if (
      newLineAt <= 0 ||
      above.kind === "time" ||
      above.kind === "exchange" ||
      above.tail
    )
      return items
    return items.map((item, i) =>
      i === newLineAt - 1 ? { ...above, tail: true } : item
    )
  }, [items, newLineAt])

  // ── the rows virtua draws ───────────────────────────────────────────────
  // Only those in and near the view are drawn: a long conversation costs
  // what a short one does. An item a row, keyed as the item is — what is in
  // it (an answer being typed into a card) stays whatever comes in around
  // it; the way to load older ones over them, not one of them — older ones
  // come in as the list's first rows (`shift`).
  const listRows = useMemo<ListRow[]>(
    () =>
      listRowsOf(placed, newLineAt).map((row, i) => ({
        ...row,
        first: i === 0 && !hasOlder,
      })),
    [placed, newLineAt, hasOlder]
  )
  // Opened, the newest rows alone (`TAIL_ROWS`), from the row picked then.
  if (tailOnly && !settled && tailKey == null && listRows.length > TAIL_ROWS) {
    setTailKey(listRows[listRows.length - TAIL_ROWS].key)
  }
  const tailAt =
    tailOnly && tailKey != null
      ? listRows.findIndex((r) => r.key === tailKey)
      : -1
  const base = Math.max(0, tailAt)
  const drawn = useMemo(
    () => (base > 0 ? listRows.slice(base) : listRows),
    [listRows, base]
  )
  const tailing = base > 0
  useLayoutEffect(() => {
    tailingRef.current = tailing
  }, [tailing])
  // Which row draws each message — where a jump scrolls to — among those
  // drawn; and, while only the newest are, whether one is held at all (a
  // jump to it waits for the rest).
  const rowIndex = useMemo(() => {
    const m = new Map<number, number>()
    drawn.forEach((row, i) => {
      for (const id of itemRowIds(row.item)) m.set(id, i)
    })
    return m
  }, [drawn])
  const heldIds = useMemo(() => {
    if (!tailing) return null
    const held = new Set<number>()
    for (const row of listRows)
      for (const id of itemRowIds(row.item)) held.add(id)
    return held
  }, [listRows, tailing])

  // The way to load older messages, over the rows: virtua is told its
  // height.
  const [olderHeight, setOlderHeight] = useState(0)
  const olderHeightRef = useRef(0)
  useLayoutEffect(() => {
    olderHeightRef.current = olderHeight
  }, [olderHeight])
  const olderObserver = useRef<ResizeObserver | null>(null)
  const olderRef = useCallback((el: HTMLDivElement | null) => {
    olderObserver.current?.disconnect()
    olderObserver.current = null
    if (!el) {
      setOlderHeight(0)
      return
    }
    const read = () => setOlderHeight(el.getBoundingClientRect().height)
    read()
    if (typeof ResizeObserver !== "undefined") {
      olderObserver.current = new ResizeObserver(read)
      olderObserver.current.observe(el)
    }
  }, [])

  const rowIndexRef = useRef(rowIndex)
  const heldIdsRef = useRef(heldIds)
  useLayoutEffect(() => {
    rowIndexRef.current = rowIndex
    heldIdsRef.current = heldIds
  }, [rowIndex, heldIds])

  // Older messages loaded in above, or the rest drawn in above the newest:
  // the view keeps to what it showed (virtua counts from the end) — on the
  // render that draws them, and only then: rows added after it (more coming
  // in at the end) are not more of them. Marked only when the first row
  // changes, so a reply growing costs no second render.
  const firstRowId = rows[0]?.id ?? null
  const [shiftMark, setShiftMark] = useState({
    bot: botId,
    first: firstRowId,
    base,
    length: drawn.length,
    shift: false,
  })
  if (
    shiftMark.bot !== botId ||
    shiftMark.first !== firstRowId ||
    shiftMark.base !== base
  ) {
    setShiftMark({
      bot: botId,
      first: firstRowId,
      base,
      length: drawn.length,
      shift:
        shiftMark.bot === botId &&
        ((shiftMark.first != null &&
          firstRowId != null &&
          firstRowId < shiftMark.first) ||
          base < shiftMark.base),
    })
  }
  const shift =
    shiftMark.shift &&
    shiftMark.bot === botId &&
    shiftMark.first === firstRowId &&
    shiftMark.base === base &&
    shiftMark.length === drawn.length

  // Kept drawn whatever the scroll: a card waiting for the owner (what they
  // started typing into it stays), and the rows near the end once the view
  // is there — drawn again as the scroll settles, a row measured at another
  // height above the view would nudge it a pixel, and the bottom pull it
  // back, over and over (see `rowsKeptNearEnd`).
  const [keepFromKey, setKeepFromKey] = useState<string | null>(null)
  const keepMounted = useMemo(() => {
    const keep = new Set<number>()
    for (const id of waits) {
      const at = rowIndex.get(id)
      if (at != null) keep.add(at)
    }
    if (keepFromKey != null) {
      const from = drawn.findIndex((r) => r.key === keepFromKey)
      if (from >= 0) for (let i = from; i < drawn.length; i++) keep.add(i)
    }
    return keep.size > 0 ? [...keep].sort((a, b) => a - b) : undefined
  }, [waits, rowIndex, keepFromKey, drawn])
  // The rows virtua is handed, by its indexes.
  const listRowsRef = useRef(drawn)
  useLayoutEffect(() => {
    listRowsRef.current = drawn
  }, [drawn])
  const updateKept = useCallback((offset: number) => {
    const handle = listRef.current
    if (!handle) return
    const at = rowsKeptNearEnd({
      offset,
      viewportSize: handle.viewportSize,
      scrollSize: handle.scrollSize,
      bufferSize: BUFFER_PX,
      findItemIndex: (o) => handle.findItemIndex(o),
    })
    const key = at == null ? null : (listRowsRef.current[at]?.key ?? null)
    setKeepFromKey((held) => (held === key ? held : key))
  }, [])
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      updateKept(listRef.current?.scrollOffset ?? 0)
    )
    return () => cancelAnimationFrame(frame)
  }, [drawn, updateKept])

  // ── jumps ───────────────────────────────────────────────────────────────
  // A jump asked for before the list is drawn: made once it is.
  const queuedJump = useRef<number | null>(null)
  const scrollToRow = useCallback(
    (id: number): boolean => {
      // Held, but not drawn while only the newest rows are: once the rest
      // are.
      if (tailingRef.current && heldIdsRef.current?.has(id)) {
        atBottom.current = false
        queuedJump.current = id
        return true
      }
      const index = rowIndexRef.current.get(id)
      if (index == null) return false
      const handle = listRef.current
      const root = scrollRef.current
      atBottom.current = false
      if (!handle || !root) {
        queuedJump.current = id
        return true
      }
      // To where its row is reckoned to be, so it is drawn; then the
      // message itself — a card inside a reply taller than the view is not
      // where the row's middle is — is held in the middle as the rows round
      // it are drawn and measured (`holdJump`), and flashed.
      keepAt.current = null
      root.scrollTop = Math.max(
        0,
        olderHeightRef.current +
          handle.getItemOffset(index) +
          handle.getItemSize(index) / 2 -
          root.clientHeight / 2
      )
      lastTop.current = root.scrollTop
      const held = {
        id,
        key: listRowsRef.current[index]?.key ?? "",
        since: performance.now(),
        until: Infinity,
      }
      jumpHold.current = held
      let frames = 0
      const look = () => {
        if (jumpHold.current !== held) return
        const target = jumpTarget(root, held, frames >= JUMP_OWN_FRAMES)
        if (target && held.until === Infinity) {
          holdJump()
          held.until = performance.now() + JUMP_HOLD_MS
          flash(target.querySelector<HTMLElement>("[data-bubble]") ?? target)
        } else holdJump()
        frames += 1
        if (held.until !== Infinity || frames < JUMP_FRAMES) {
          requestAnimationFrame(look)
        } else if (jumpHold.current === held) jumpHold.current = null
      }
      requestAnimationFrame(look)
      return true
    },
    [flash, holdJump]
  )
  useEffect(() => {
    if (!settled || queuedJump.current == null) return
    const id = queuedJump.current
    queuedJump.current = null
    scrollToRow(id)
  }, [settled, scrollToRow])

  const jumpTo = useCallback(
    (id: number) => {
      const seq = ++jumpSeq.current
      queuedJump.current = null
      if (scrollToRow(id)) return
      const oldest = rows[0]?.id
      if (oldest == null || id >= oldest) {
        // Held but not drawn (a marker), or newer than anything held.
        setPreview(id)
        return
      }
      loadSince(id)
        .then((outcome) => {
          if (seq !== jumpSeq.current) return
          if (outcome === "too_far") {
            setPreview(id)
            return
          }
          // Drawn on a coming render: the list then knows its row.
          let tries = 0
          const again = () => {
            if (seq !== jumpSeq.current) return
            if (scrollToRow(id)) return
            tries += 1
            if (tries < 10) requestAnimationFrame(again)
            else setPreview(id)
          }
          requestAnimationFrame(again)
        })
        .catch((e) => toast.error(toErrorMessage(e)))
    },
    [rows, loadSince, scrollToRow]
  )

  useEffect(() => {
    jumpRef.current = jumpTo
  }, [jumpRef, jumpTo])

  // A prompt the agent waits on that no reply bubble shows (a turn with no
  // reply row): at the end of the list.
  const promptInBubble =
    scope.liveRowId != null && rowsById.has(scope.liveRowId)
  const orphanPrompt =
    !promptInBubble && !scope.readOnly && scope.connectionId && scope.agentType

  const shown = scrollReady && settled
  const renderRow = (row: ListRow) => (
    <RowView
      key={row.key}
      row={row}
      enters={enters(row.item)}
      onSeen={clearNewFrom}
    />
  )

  return (
    <>
      <div ref={frameRef} className="relative flex min-h-0 flex-1 flex-col">
        <Pill
          shown={pillShown && shown}
          className="top-2"
          onClick={() => {
            if (pill?.today) {
              showWaiting(activity?.pill.first ?? null)
              return
            }
            const first = waits[0]
            if (first != null) jumpTo(first)
          }}
          onDismiss={() => dismissAttention(conversation, pillKeys)}
          dismissLabel={tp("dismissAttention")}
          data-pa-pill="attention"
        >
          <BellRing className="size-3.5 text-orange-500" aria-hidden />
          {tp("attention", { count: pill?.count ?? 0 })}
        </Pill>
        <Pill
          shown={newBelow && shown}
          className="bottom-3"
          onClick={() => toBottom(true)}
          data-pa-pill="new"
        >
          <ArrowDown className="size-3.5" aria-hidden />
          {tp("newMessages")}
        </Pill>
        {/* Up the page with nothing new under them: the way back down —
            a conversation's own, shown when it would show there (the pill
            above says more when there is). */}
        {far && !newBelow && shown ? (
          <ScrollToLatestButton
            className="z-10"
            onClick={() => toBottom(true)}
            title={tp("toBottom")}
            aria-label={tp("toBottom")}
            data-pa-pill="bottom"
          />
        ) : null}
        <ScrollArea
          className="min-h-0 flex-1"
          onViewportRef={onViewport}
          defer={false}
        >
          <div
            ref={contentRef}
            data-pa-list
            className={cn(
              // The bottom keeps room for the last message's actions, which
              // float under it.
              "ws-msg-scope mx-auto flex w-full chat-content-w flex-col px-4 pb-8",
              // Drawn once it is at its bottom — no flash of the oldest
              // messages first — and coming in then, a little up into
              // place, when the chat view moves (an assistant switched to).
              motion && "transition-[opacity,translate] duration-200 ease-out",
              !shown && "invisible opacity-0",
              !shown && motion && "translate-y-1.5"
            )}
          >
            {hasOlder ? (
              <div ref={olderRef} className="flex justify-center pt-4 pb-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs text-muted-foreground"
                  disabled={loadingOlder}
                  data-pa-load-older
                  onClick={() => {
                    const seq = shownSeq.current
                    setLoadingOlder(true)
                    // Where the reader was is kept as they come in above:
                    // the messages in the view (not the lines, which older
                    // ones can take in or take away).
                    const root = scrollRef.current
                    const view = root?.getBoundingClientRect()
                    const messages = new Set(
                      listRowsRef.current
                        .filter((r) => !isLine(r.item))
                        .map((r) => r.key)
                    )
                    const rows =
                      root && view
                        ? [
                            ...root.querySelectorAll<HTMLElement>(
                              "[data-pa-row]"
                            ),
                          ]
                            .filter((el) => {
                              const box = el.getBoundingClientRect()
                              return (
                                messages.has(el.dataset.paRow ?? "") &&
                                box.bottom > view.top &&
                                box.top < view.bottom
                              )
                            })
                            .map((el) => ({
                              key: el.dataset.paRow ?? "",
                              top: el.getBoundingClientRect().top - view.top,
                            }))
                        : []
                    keepAt.current =
                      rows.length > 0
                        ? { rows, since: performance.now(), until: Infinity }
                        : null
                    loadOlder()
                      .catch((e) => toast.error(toErrorMessage(e)))
                      .finally(() => {
                        if (seq === shownSeq.current) setLoadingOlder(false)
                        const held = keepAt.current
                        if (!held) return
                        held.until = performance.now() + KEEP_PLACE_MS
                        // Each frame till then, besides each resize and
                        // scroll.
                        const tick = () => {
                          if (keepAt.current !== held) return
                          keepPlace()
                          if (keepAt.current === held)
                            requestAnimationFrame(tick)
                        }
                        requestAnimationFrame(tick)
                      })
                  }}
                >
                  {loadingOlder ? (
                    <SyncedSpinner small className="size-3" />
                  ) : null}
                  {t("loadOlder")}
                </Button>
              </div>
            ) : null}
            {scrollReady && drawn.length > 0 ? (
              <Virtualizer
                // Each assistant's list measured afresh.
                key={String(botId)}
                ref={listRef}
                as={ListContainer}
                scrollRef={scrollRef}
                bufferSize={BUFFER_PX}
                startMargin={olderHeight}
                shift={shift}
                keepMounted={keepMounted}
                onScroll={updateKept}
                data={drawn}
              >
                {renderRow}
              </Virtualizer>
            ) : null}
            {items.length === 0 ? (
              <p className="py-16 text-center text-sm text-muted-foreground">
                {t("empty")}
              </p>
            ) : null}
            {orphanPrompt ? (
              // On the replies' line (they carry no avatar) and no wider;
              // under the room the last message's actions float in.
              <div className="mt-8 flex max-w-[88%] flex-col gap-2 empty:hidden">
                <BlockingPrompts
                  connectionId={scope.connectionId!}
                  agentType={scope.agentType!}
                />
              </div>
            ) : null}
          </div>
        </ScrollArea>
      </div>
      <PreviewDialog
        rowId={preview}
        onOpenChange={(open) => {
          if (!open) setPreview(null)
        }}
      />
    </>
  )
}
