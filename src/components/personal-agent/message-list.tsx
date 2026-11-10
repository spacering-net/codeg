"use client"

/**
 * The conversation with the personal agent: the owner's messages, the
 * assistant's replies, and the news about the work it handed out, oldest at
 * the top, in the chat column the conversations use (the same width as the
 * input box under it). It follows the newest while the reader is at the
 * bottom (a reply growing included) and holds still while they read back;
 * a message the owner sends takes them to the bottom wherever they were.
 * Its scrollbar is the side panel's (OverlayScrollbars).
 *
 * What the assistants said is new to the owner until they see it: while
 * the list is at its bottom in a window that has focus, everything up to
 * the newest is marked seen as it lands. When they come to it — opening the
 * page, coming back to the window, scrolling back down — with something new
 * waiting, a "new messages" line goes above the first of it, and stays until
 * they leave the page or send a message.
 *
 * A jump to a message (a quote's click) scrolls it to the middle and flashes
 * it; one older than what is loaded is loaded first, and one too far back to
 * load opens as a preview instead. Each jump is numbered, so a slow load
 * answering after a newer jump never moves the page.
 *
 * Two pills float over it (10.7): "N items need you" while cards in it wait
 * for the owner (a click scrolls to the first), and "New messages" while the
 * reader is up the page and something came in under them (a click goes to
 * the bottom). A message that comes in while the page is open rises into
 * place; what was there, or is loaded from further back, does not.
 */

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useTranslations } from "next-intl"
import { ArrowDown, BellRing } from "lucide-react"
import { toast } from "sonner"

import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { JsonRenderScope } from "@/components/ai-elements/json-render-pre"
import { MessageResponse } from "@/components/ai-elements/message"
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
import { useReducedMotion } from "@/hooks/use-chat-motion"
import { toErrorMessage } from "@/lib/app-error"
import type { TimelineRow } from "@/lib/types"
import { cn } from "@/lib/utils"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"
import { EventCard } from "./event-card"
import { ExchangeRow } from "./exchange-row"
import { MirrorCard } from "./mirror-card"
import { NoticeCard } from "./notice-card"
import { BlockingPrompts } from "./live-turn"
import { useMessageTime } from "./message-actions"
import {
  buildMessageItems,
  drawnRowIds,
  newLineIndex,
  type MessageItem,
} from "./message-items"
import { OwnerBubble } from "./owner-bubble"
import { useQuoteAuthor, useQuotedRow } from "./quote-bar"
import { ReplyBubble } from "./reply-bubble"
import { followsBottom } from "./follow-bottom"
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
 * middle of the gap between two messages.
 */
function ListDivider({
  tone,
  children,
  ...attrs
}: {
  tone?: "new"
  children: React.ReactNode
} & Record<`data-${string}`, boolean>) {
  const hairline = cn(
    "flex-1 bg-transparent from-transparent",
    tone === "new" ? "to-primary/40" : "to-border/70"
  )
  return (
    <div
      {...attrs}
      data-pa-divider
      className={cn(
        "flex items-center gap-3 py-3 text-xs select-none first:pt-0",
        tone === "new" ? "text-primary" : "text-muted-foreground/80"
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

function NewLine() {
  const t = useTranslations("PersonalAgent.timeline")
  return (
    <ListDivider tone="new" data-pa-new>
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

/** A card waiting for the owner: a question or permission request still
 *  pending, a native card still open that asks them (a confirmation, a step
 *  not known to have happened, a loop stopped, the opening choice, a change
 *  shown first — not a suggestion), an executor's question forwarded to
 *  them. */
export function waitsForOwner(row: TimelineRow): boolean {
  const data = row.data
  if (row.kind === "question" || row.kind === "permission") {
    return data?.state === "pending"
  }
  // An executor's question or plan approval, once it is the owner's.
  if (row.kind === "notice" && data?.notice === "ask") {
    return data?.state === "forwarded"
  }
  if (row.kind !== "notice" || data?.state !== "open") return false
  if (data?.why === "suggest") return false
  const kind = data?.notice
  return (
    kind === "proposal" ||
    kind === "uncertain" ||
    kind === "loop" ||
    kind === "choice" ||
    kind === "changed"
  )
}

/** Where each card waiting for the owner is drawn, in order: a reply's
 *  question is in its bubble. */
export function ownerWaitTargets(items: readonly MessageItem[]): number[] {
  const out: number[] = []
  for (const item of items) {
    if (item.kind === "reply") {
      if (item.attached.some(waitsForOwner)) out.push(item.anchor.id)
    } else if (
      (item.kind === "notice" || item.kind === "mirror") &&
      waitsForOwner(item.row)
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
  onClick,
  children,
  ...rest
}: {
  shown: boolean
  className?: string
  onClick: () => void
  children: React.ReactNode
} & Record<`data-${string}`, string | boolean>) {
  return (
    <button
      type="button"
      {...rest}
      data-state={shown ? "open" : "closed"}
      aria-hidden={!shown || undefined}
      tabIndex={shown ? 0 : -1}
      onClick={onClick}
      className={cn(
        "motion-pill pointer-events-auto absolute start-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-background/95 px-3 py-1 text-xs shadow-md backdrop-blur transition-colors hover:bg-muted rtl:translate-x-1/2",
        className
      )}
    >
      {children}
    </button>
  )
}

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
          <JsonRenderScope>
            <MessageResponse
              className={cn(MARKDOWN_LIST_ROOM, BUBBLE_MARKDOWN)}
            >
              {row.kind === "result"
                ? [str(row.data, "title"), str(row.data, "excerpt") ?? row.body]
                    .filter(Boolean)
                    .join("\n\n")
                : row.body || t("noText")}
            </MessageResponse>
          </JsonRenderScope>
        </ScrollArea>
      )}
    </>
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
  const { botId, rows, hasOlder, loadOlder, loadSince, snapshot } =
    usePersonalAgent()
  const reduced = useReducedMotion()
  const items = useMemo(() => buildMessageItems(rows), [rows])
  const drawn = useMemo(() => drawnRowIds(items), [items])
  const rowsById = scope.rowsById

  // The OverlayScrollbars viewport: it initializes a few frames after
  // mount, so everything that scrolls waits for it.
  const scrollRef = useRef<HTMLElement | null>(null)
  const [scrollReady, setScrollReady] = useState(false)
  const onViewport = useCallback((el: HTMLElement | null) => {
    scrollRef.current = el
    setScrollReady(el != null)
  }, [])
  const contentRef = useRef<HTMLDivElement | null>(null)
  const atBottom = useRef(true)
  // The same, for what renders on it.
  const [bottomed, setBottomed] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [preview, setPreview] = useState<number | null>(null)
  const jumpSeq = useRef(0)

  // Follow what comes in — a new row, a reply growing, a step's height
  // animating — while the reader is at the bottom. Content changes size
  // without React re-rendering it (a transition), so watch the size itself.
  useEffect(() => {
    const el = scrollRef.current
    const content = contentRef.current
    if (!el || !content || typeof ResizeObserver === "undefined") return
    const follow = () => {
      if (atBottom.current) el.scrollTop = el.scrollHeight
    }
    let lastTop = el.scrollTop
    const onScroll = () => {
      atBottom.current = followsBottom({
        was: atBottom.current,
        gap: el.scrollHeight - el.scrollTop - el.clientHeight,
        top: el.scrollTop,
        lastTop,
      })
      lastTop = el.scrollTop
      setBottomed(atBottom.current)
    }
    const ro = new ResizeObserver(follow)
    ro.observe(content)
    follow()
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      ro.disconnect()
      el.removeEventListener("scroll", onScroll)
    }
  }, [scrollReady])

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

  const scrollToRow = useCallback(
    (id: number) => {
      const root = scrollRef.current
      const el = root?.querySelector<HTMLElement>(`[data-row-id="${id}"]`)
      if (!root || !el) return false
      atBottom.current = false
      el.scrollIntoView({
        block: "center",
        behavior: reduced ? "auto" : "smooth",
      })
      // Once more after the next paint: rows drawn just now may have moved
      // it.
      requestAnimationFrame(() => {
        const again = root.querySelector<HTMLElement>(`[data-row-id="${id}"]`)
        again?.scrollIntoView({ block: "center", behavior: "auto" })
      })
      flash(el.querySelector<HTMLElement>("[data-bubble]") ?? el)
      return true
    },
    [flash, reduced]
  )

  const jumpTo = useCallback(
    (id: number) => {
      const seq = ++jumpSeq.current
      if (drawn.has(id) && scrollToRow(id)) return
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
          // Drawn on the next render.
          requestAnimationFrame(() => {
            if (seq !== jumpSeq.current) return
            if (!scrollToRow(id)) setPreview(id)
          })
        })
        .catch((e) => toast.error(toErrorMessage(e)))
    },
    [drawn, rows, loadSince, scrollToRow]
  )

  useEffect(() => {
    jumpRef.current = jumpTo
  }, [jumpRef, jumpTo])

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
  // from there; what was new is behind them now.
  const toBottom = useCallback(() => {
    clearNewFrom()
    const el = scrollRef.current
    if (!el) return
    atBottom.current = true
    setBottomed(true)
    el.scrollTop = el.scrollHeight
  }, [clearNewFrom])
  useEffect(() => {
    sentRef.current = toBottom
  }, [sentRef, toBottom])
  const newLineAt = newFrom != null ? newLineIndex(items, newFrom) : -1

  // ── what rises into place, and the pills ────────────────────────────────
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
      enterFrom != null &&
      enterFrom.bot === botId &&
      !enterFrom.keys.has(item.key) &&
      id != null &&
      id > enterFrom.id
    )
  }
  // Up the page when something came in under the reader.
  const [leftAt, setLeftAt] = useState<number | null>(null)
  if (bottomed && leftAt != null) setLeftAt(null)
  else if (!bottomed && leftAt == null) setLeftAt(lastId)
  const newBelow = leftAt != null && lastId > leftAt
  const waits = useMemo(() => ownerWaitTargets(items), [items])
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

  // A prompt the agent waits on that no reply bubble shows (a turn with no
  // reply row): at the end of the list.
  const promptInBubble =
    scope.liveRowId != null && rowsById.has(scope.liveRowId)
  const orphanPrompt =
    !promptInBubble && !scope.readOnly && scope.connectionId && scope.agentType

  return (
    <>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <Pill
          shown={waits.length > 0 && scrollReady}
          className="top-2"
          onClick={() => {
            const first = waits[0]
            if (first != null) jumpTo(first)
          }}
          data-pa-pill="attention"
        >
          <BellRing className="size-3.5 text-orange-500" aria-hidden />
          {tp("attention", { count: waits.length })}
        </Pill>
        <Pill
          shown={newBelow && scrollReady}
          className="bottom-3"
          onClick={toBottom}
          data-pa-pill="new"
        >
          <ArrowDown className="size-3.5" aria-hidden />
          {tp("newMessages")}
        </Pill>
        <ScrollArea
          className="min-h-0 flex-1"
          onViewportRef={onViewport}
          defer={false}
        >
          <div
            ref={contentRef}
            className={cn(
              // The bottom keeps room for the last message's actions, which
              // float under it.
              "ws-msg-scope mx-auto flex w-full chat-content-w flex-col px-4 pt-4 pb-8",
              // Drawn once the viewport is there to put it at the bottom: no
              // flash of the oldest messages first.
              !scrollReady && "invisible"
            )}
          >
            {hasOlder ? (
              <div className="flex justify-center pb-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs text-muted-foreground"
                  disabled={loadingOlder}
                  onClick={() => {
                    const el = scrollRef.current
                    const before = el?.scrollHeight ?? 0
                    setLoadingOlder(true)
                    loadOlder()
                      .then(() => {
                        // Keep the reader where they were.
                        requestAnimationFrame(() => {
                          if (el) el.scrollTop += el.scrollHeight - before
                        })
                      })
                      .catch((e) => toast.error(toErrorMessage(e)))
                      .finally(() => setLoadingOlder(false))
                  }}
                >
                  {loadingOlder ? (
                    <SyncedSpinner small className="size-3" />
                  ) : null}
                  {t("loadOlder")}
                </Button>
              </div>
            ) : null}
            {items.length === 0 ? (
              <p className="py-16 text-center text-sm text-muted-foreground">
                {t("empty")}
              </p>
            ) : null}
            {placed.map((item, i) => (
              <Fragment key={item.key}>
                {i === newLineAt ? <NewLine /> : null}
                {enters(item) ? (
                  <div className="motion-message-enter">
                    <Item item={item} />
                  </div>
                ) : (
                  <Item item={item} />
                )}
              </Fragment>
            ))}
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
