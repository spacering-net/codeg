"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { CheckIcon, CopyIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { ScrollArea } from "@/components/ui/scroll-area"
import { cn, copyTextToClipboard } from "@/lib/utils"

/**
 * The one container every row's detail goes in: a tinted, rounded panel whose
 * body scrolls past a fixed height on the app's overlay scrollbars (fading out
 * at an edge with more beyond it), with an optional header — the file a read
 * or an edit is about — and an optional footer: a line count on the start
 * side, copy actions on the end side. Both stay put while the body scrolls.
 *
 * `anchor="end"` opens scrolled to the bottom and stays there while content
 * streams in (a failing test run's summary is at the end); the default opens
 * at the top.
 */
export function DetailBox({
  children,
  tone = "neutral",
  anchor = "start",
  header,
  footer,
  actions,
  className,
  bodyClassName,
  unbounded = false,
}: {
  children: ReactNode
  tone?: "neutral" | "danger" | "plain"
  anchor?: "start" | "end"
  /** A bar above the body: what the detail is (a file's name and figures). */
  header?: ReactNode
  /** Start-side footer text, e.g. "12 lines". */
  footer?: ReactNode
  /** End-side footer actions (copy buttons). */
  actions?: ReactNode
  className?: string
  bodyClassName?: string
  /** No height cap — for content that caps and scrolls its own parts (the
   *  halves of a side-by-side diff, a script and its output, each in a
   *  `DetailScroll`). */
  unbounded?: boolean
}) {
  const { onViewportRef, onScroll } = useScrollBody(anchor)

  const rule =
    tone === "danger" ? "border-tone-danger/15" : "border-foreground/5"

  return (
    <div
      // Over a workspace background image the panel turns translucent and
      // takes a hairline border (`ws-msg-panel`; a failed one's red-tinted).
      data-tone={tone}
      className={cn(
        "activity-detail-box ws-msg-panel overflow-hidden rounded-[0.625rem]",
        tone === "neutral" && "bg-activity-surface ws-msg-card",
        tone === "danger" && "bg-tone-danger-surface",
        tone === "plain" && "border border-border bg-background ws-msg-card",
        className
      )}
    >
      {header ? (
        <div
          className={cn(
            "flex min-h-8 items-center gap-3 border-b px-4 text-xs text-muted-foreground",
            rule
          )}
        >
          {header}
        </div>
      ) : null}
      <ScrollArea
        className={cn(!unbounded && "max-h-72")}
        x="scroll"
        y={unbounded ? "hidden" : "scroll"}
        onScroll={onScroll}
        onViewportRef={onViewportRef}
      >
        <div className={bodyClassName}>{children}</div>
      </ScrollArea>
      {footer || actions ? (
        <div
          className={cn(
            "activity-mono flex min-h-7 items-center gap-3 border-t px-4 text-xs text-muted-foreground",
            rule
          )}
        >
          <span className="min-w-0 truncate tabular-nums">{footer}</span>
          {actions ? (
            <span className="ms-auto flex shrink-0 items-center gap-3">
              {actions}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * The edge fade of a scroll body (globals.css): its OverlayScrollbars
 * viewport — there once the library has set up — takes the class the fade
 * masks, and `data-overflow` says at which edges more lies beyond, kept
 * current as it scrolls (call `measure`) and as it or its content changes
 * size. Each scroll body tags its own viewport, so the fade masks the one
 * that scrolls and no scroll area nested in it. `onResize` runs on a size
 * change first (a box that follows its end).
 */
function useEdgeFade(onResize?: (viewport: HTMLElement) => void) {
  const viewportRef = useRef<HTMLElement | null>(null)
  const [viewport, setViewport] = useState<HTMLElement | null>(null)
  const onViewportRef = useCallback((node: HTMLElement | null) => {
    viewportRef.current = node
    node?.classList.add("activity-detail-viewport")
    setViewport(node)
  }, [])

  const measure = useCallback(() => {
    const node = viewportRef.current
    if (!node) return
    const above = node.scrollTop > 1
    const below = node.scrollTop + node.clientHeight < node.scrollHeight - 1
    const overflow =
      above && below ? "both" : above ? "start" : below ? "end" : null
    if (overflow) node.dataset.overflow = overflow
    else delete node.dataset.overflow
  }, [])

  // Only an open panel is mounted, so only it pays for observing its size.
  useEffect(() => {
    if (!viewport || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => {
      onResize?.(viewport)
      measure()
    })
    observer.observe(viewport)
    if (viewport.firstElementChild) observer.observe(viewport.firstElementChild)
    return () => observer.disconnect()
  }, [viewport, onResize, measure])

  return { viewportRef, onViewportRef, measure }
}

/**
 * A scroll body's handlers: its edge fade, and its anchor — `"end"` opens it
 * scrolled to the bottom and keeps it there as content streams in, until the
 * reader scrolls up from it.
 */
function useScrollBody(anchor: "start" | "end") {
  const stickToEnd = useRef(anchor === "end")
  const followEnd = useCallback((node: HTMLElement) => {
    if (stickToEnd.current) node.scrollTop = node.scrollHeight
  }, [])
  const { viewportRef, onViewportRef, measure } = useEdgeFade(followEnd)

  useLayoutEffect(() => {
    if (viewportRef.current) followEnd(viewportRef.current)
  })

  const onScroll = useCallback(() => {
    const node = viewportRef.current
    if (node && anchor === "end") {
      stickToEnd.current =
        node.scrollTop + node.clientHeight >= node.scrollHeight - 4
    }
    measure()
  }, [anchor, measure, viewportRef])

  return { onViewportRef, onScroll }
}

/**
 * A scroll body of its own inside a detail box, capped at the box's height:
 * it scrolls both ways, fades at an edge with more beyond it and keeps to its
 * `anchor`, as the box's body does — for parts that each keep their
 * scrollbars at the foot and the side of what shows where the box itself
 * does not scroll (`unbounded`): the halves of a side-by-side diff, a script
 * and its output. `onViewportRef` and `onScroll` pass through, to pair two of
 * them.
 */
export function DetailScroll({
  children,
  className,
  anchor = "start",
  onViewportRef,
  onScroll,
}: {
  children: ReactNode
  className?: string
  anchor?: "start" | "end"
  onViewportRef?: (viewport: HTMLElement | null) => void
  onScroll?: () => void
}) {
  const { onViewportRef: tagViewport, onScroll: ownScroll } =
    useScrollBody(anchor)
  const handleViewportRef = useCallback(
    (node: HTMLElement | null) => {
      tagViewport(node)
      onViewportRef?.(node)
    },
    [tagViewport, onViewportRef]
  )
  const handleScroll = useCallback(() => {
    ownScroll()
    onScroll?.()
  }, [ownScroll, onScroll])
  return (
    <ScrollArea
      className={cn("max-h-72", className)}
      x="scroll"
      y="scroll"
      onViewportRef={handleViewportRef}
      onScroll={handleScroll}
    >
      {children}
    </ScrollArea>
  )
}

/** A footer action that copies text and briefly confirms it. */
export function CopyAction({
  text,
  label,
}: {
  text: string | (() => string)
  label: string
}) {
  const t = useTranslations("Folder.chat.activity")
  const [copied, setCopied] = useState(false)
  const timer = useRef<number>(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={async () => {
        const ok = await copyTextToClipboard(
          typeof text === "function" ? text() : text
        )
        if (!ok) return
        setCopied(true)
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setCopied(false), 1500)
      }}
    >
      {copied ? (
        <CheckIcon aria-hidden="true" className="size-3" />
      ) : (
        <CopyIcon aria-hidden="true" className="size-3" />
      )}
      {copied ? t("detail.copied") : label}
    </button>
  )
}
