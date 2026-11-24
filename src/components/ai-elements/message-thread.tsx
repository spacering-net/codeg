"use client"

import type { ComponentProps } from "react"

import { Button } from "@/components/ui/button"
import { useChatAnimationsEnabled } from "@/hooks/use-appearance"
import { cn } from "@/lib/utils"
import { ArrowDownIcon, DownloadIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useCallback, useEffect } from "react"
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom"

/**
 * Keeps the thread pinned when the SCROLL VIEWPORT changes height. Renders
 * nothing; mounted by `MessageThread` itself because it consumes the
 * stick-to-bottom context and so has to live inside the provider.
 *
 * `use-stick-to-bottom` observes only the CONTENT element — a resize there is
 * new transcript, and it re-sticks. Nothing observes the scroll element, yet
 * the siblings BELOW the thread resize it constantly: the live-turn stats bar
 * mounting when a turn starts, an ask-question / plan-approval card or a
 * failure strip opening in the composer dock, the composer growing with the
 * draft — and the terminal panel, which the workspace shell force-collapses for
 * the duration of a full-page route (tasks / automations / …) and restores on
 * the way back (see `app/workspace/layout.tsx`). Both directions are broken
 * without this:
 *
 * - The viewport SHRINKS: `scrollHeight` and `scrollTop` are both untouched, so
 *   the maximum scroll offset grows out from under the thread. No scroll event
 *   and no content resize fire, so the library never learns, and the tail of
 *   the turn stays below the fold. Inside the library's 70px "near bottom"
 *   slack the scroll-to-bottom button stays hidden too — which is what makes it
 *   read as a thread that is already at the bottom and still cut off.
 * - The viewport GROWS: the maximum scroll offset drops below the current
 *   position and the browser clamps it, firing a real scroll event with a LOWER
 *   `scrollTop`. The library reads that as the user scrolling up, escapes the
 *   lock, and stops following the stream for the rest of the turn.
 *
 * Only a thread that was already at the bottom is re-pinned, so a user who
 * scrolled back into history is never yanked forward.
 */
const StickThroughViewportResize = () => {
  const { scrollRef, scrollToBottom, state } = useStickToBottomContext()

  useEffect(() => {
    const viewport = scrollRef.current
    if (!viewport) return

    let previousHeight: number | undefined
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const { height } = entry.contentRect
      // First delivery reports the current size, not a change — same guard the
      // library uses on its own content observer.
      const difference = height - (previousHeight ?? height)
      previousHeight = height
      if (!difference || !state.isAtBottom) return

      // The library's shield around its own content resizes, reused for ours:
      // it makes `handleScroll` ignore the scroll events this resize provokes
      // (the clamp above, and the re-pin below) rather than reading them as the
      // user leaving the bottom. Released a frame later, and only if no later
      // resize has claimed it since — again mirroring the library.
      state.resizeDifference = difference
      requestAnimationFrame(() => {
        setTimeout(() => {
          if (state.resizeDifference === difference) {
            state.resizeDifference = 0
          }
        }, 1)
      })

      // `preserveScrollPosition` suppresses only the redundant "we're at the
      // bottom" state write — the guard above already established that. A
      // growth resize lands at the target on its own, so this is then a no-op.
      scrollToBottom({ animation: "instant", preserveScrollPosition: true })
    })

    observer.observe(viewport)
    return () => {
      observer.disconnect()
    }
  }, [scrollRef, scrollToBottom, state])

  return null
}

/** Keys that scroll a focused viewport towards the top of the transcript. */
const SCROLL_UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"])

/** A finger has to travel this far down before the drag counts as intent. */
const TOUCH_ESCAPE_SLOP_PX = 6

/**
 * Whether something between `target` and the viewport scrolls vertically and
 * can still move up, so it — not the transcript — takes the upward gesture.
 */
const nestedScrollerTakesUpward = (
  target: EventTarget | null,
  viewport: HTMLElement
): boolean => {
  let element = target instanceof Element ? target : null
  while (element && element !== viewport) {
    if (
      element instanceof HTMLElement &&
      element.scrollTop > 0 &&
      element.scrollHeight > element.clientHeight
    ) {
      const { overflowY } = getComputedStyle(element)
      if (overflowY === "auto" || overflowY === "scroll") return true
    }
    element = element.parentElement
  }
  return false
}

const isEditableTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || target.closest("input,textarea,select") !== null)

/**
 * Releases the bottom lock the moment the user starts scrolling towards older
 * messages. Renders nothing; mounted by `MessageThread` beside the viewport
 * sticker.
 *
 * `use-stick-to-bottom` only learns about an escape in two ways, and neither
 * holds up under a virtualized, streaming transcript:
 *
 * - Its wheel listener walks up from the event target to the first element
 *   whose computed `overflow` is `auto`/`scroll` and escapes only when that is
 *   the viewport. Code blocks, tables and tool output are `overflow-auto`, so a
 *   wheel over any of them never escapes.
 * - Its scroll listener discards every scroll event that lands while a content
 *   resize is in flight (`resizeDifference`). Streaming grows the content every
 *   flush, and virtua re-measures rows as they mount, so touch, scrollbar and
 *   keyboard scrolls are discarded nearly every time.
 *
 * The lock then stays engaged while the user reads history, and the next
 * content growth (a streamed token, a freshly measured row) or viewport resize
 * scrolls them back to the bottom. This reads the user's intent from the input
 * itself, which no resize can disguise, and escapes on it.
 */
const EscapeLockOnUserScroll = () => {
  const { scrollRef, stopScroll, state } = useStickToBottomContext()

  useEffect(() => {
    const viewport = scrollRef.current
    if (!viewport) return

    const escape = () => {
      if (state.escapedFromLock && !state.isAtBottom) return
      // A deliberate `ignoreEscapes` scroll keeps its lock, as in the library.
      if (state.animation?.ignoreEscapes) return
      if (viewport.scrollHeight <= viewport.clientHeight) return
      stopScroll()
    }

    const onWheel = (event: WheelEvent) => {
      if (event.deltaY >= 0 || event.ctrlKey) return
      // A mostly sideways wheel (a trackpad swipe along a wide code block or
      // table) drifts a little up or down, but it is not a scroll towards older
      // messages: when a horizontal scroller takes it the transcript never
      // moves, so it must not release the lock either.
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
      if (nestedScrollerTakesUpward(event.target, viewport)) return
      escape()
    }

    // Where the finger was at the top of its travel so far, so an up-then-down
    // drag is measured from where it turned.
    let touchFrom: { x: number; y: number } | null = null
    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches.length === 1 ? event.touches[0] : null
      touchFrom = touch ? { x: touch.clientX, y: touch.clientY } : null
    }
    const onTouchMove = (event: TouchEvent) => {
      if (touchFrom === null || event.touches.length !== 1) return
      // Finger moving down drags the content down: scrolling towards the top.
      const { clientX: x, clientY: y } = event.touches[0]
      if (y < touchFrom.y) {
        touchFrom = { x, y }
        return
      }
      const travel = y - touchFrom.y
      if (travel < TOUCH_ESCAPE_SLOP_PX) return
      // Decided once per touch, the way the browser settles a pan's axis. A
      // sideways pan (across a code block or table) that drifts down is not a
      // drag of the transcript, so it leaves the lock alone.
      const sideways = Math.abs(x - touchFrom.x) > travel
      touchFrom = null
      if (sideways) return
      if (nestedScrollerTakesUpward(event.target, viewport)) return
      escape()
    }
    const onTouchEnd = () => {
      touchFrom = null
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey) return
      if (event.metaKey && event.key !== "ArrowUp") return
      const upward =
        SCROLL_UP_KEYS.has(event.key) || (event.key === " " && event.shiftKey)
      if (!upward || isEditableTarget(event.target)) return
      if (nestedScrollerTakesUpward(event.target, viewport)) return
      escape()
    }

    // Dragging the native scrollbar: a primary press on the viewport element
    // itself, then any upward scroll until the press ends. A press on the
    // transcript targets the content inside the viewport, so a press whose
    // target is the viewport landed on its scrollbar or gutter. That is checked
    // by target rather than position because an overlay scrollbar (the macOS
    // default) takes no layout space: it is drawn inside the client box.
    let draggingScrollbar = false
    let lastScrollTop = viewport.scrollTop
    const onPointerDown = (event: PointerEvent) => {
      draggingScrollbar = event.target === viewport && event.button === 0
      lastScrollTop = viewport.scrollTop
    }
    const onPointerEnd = () => {
      draggingScrollbar = false
    }
    const onScroll = () => {
      const { scrollTop } = viewport
      if (draggingScrollbar && scrollTop < lastScrollTop) escape()
      lastScrollTop = scrollTop
    }

    viewport.addEventListener("wheel", onWheel, { passive: true })
    viewport.addEventListener("touchstart", onTouchStart, { passive: true })
    viewport.addEventListener("touchmove", onTouchMove, { passive: true })
    viewport.addEventListener("touchend", onTouchEnd, { passive: true })
    viewport.addEventListener("touchcancel", onTouchEnd, { passive: true })
    viewport.addEventListener("keydown", onKeyDown)
    viewport.addEventListener("pointerdown", onPointerDown)
    viewport.addEventListener("scroll", onScroll, { passive: true })
    window.addEventListener("pointerup", onPointerEnd)
    window.addEventListener("pointercancel", onPointerEnd)
    return () => {
      viewport.removeEventListener("wheel", onWheel)
      viewport.removeEventListener("touchstart", onTouchStart)
      viewport.removeEventListener("touchmove", onTouchMove)
      viewport.removeEventListener("touchend", onTouchEnd)
      viewport.removeEventListener("touchcancel", onTouchEnd)
      viewport.removeEventListener("keydown", onKeyDown)
      viewport.removeEventListener("pointerdown", onPointerDown)
      viewport.removeEventListener("scroll", onScroll)
      window.removeEventListener("pointerup", onPointerEnd)
      window.removeEventListener("pointercancel", onPointerEnd)
    }
  }, [scrollRef, stopScroll, state])

  return null
}

export type MessageThreadProps = ComponentProps<typeof StickToBottom>

export const MessageThread = ({
  className,
  children,
  ...props
}: MessageThreadProps) => (
  <StickToBottom
    className={cn("relative flex-1 overflow-y-hidden", className)}
    initial="instant"
    resize="smooth"
    role="log"
    {...props}
  >
    {(context) => (
      <>
        <StickThroughViewportResize />
        <EscapeLockOnUserScroll />
        {typeof children === "function" ? children(context) : children}
      </>
    )}
  </StickToBottom>
)

export type MessageThreadContentProps = ComponentProps<
  typeof StickToBottom.Content
>

export const MessageThreadContent = ({
  className,
  ...props
}: MessageThreadContentProps) => (
  <StickToBottom.Content
    className={cn("flex flex-col gap-8 p-4", className)}
    {...props}
  />
)

export type MessageThreadEmptyStateProps = ComponentProps<"div"> & {
  title?: string
  description?: string
  icon?: React.ReactNode
}

export const MessageThreadEmptyState = ({
  className,
  title,
  description,
  icon,
  children,
  ...props
}: MessageThreadEmptyStateProps) => {
  const t = useTranslations("Folder.chat.messageThread")
  return (
    <div
      className={cn(
        "flex size-full flex-col items-center justify-center gap-3 p-8 text-center",
        className
      )}
      {...props}
    >
      {children ?? (
        <>
          {icon && <div className="text-muted-foreground">{icon}</div>}
          <div className="space-y-1">
            <h3 className="font-medium text-sm">{title ?? t("emptyTitle")}</h3>
            {(description ?? t("emptyDescription")) && (
              <p className="text-muted-foreground text-sm">
                {description ?? t("emptyDescription")}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export type MessageThreadScrollButtonProps = ComponentProps<typeof Button>

export const MessageThreadScrollButton = ({
  className,
  ...props
}: MessageThreadScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext()
  const chatAnimations = useChatAnimationsEnabled()

  const handleScrollToBottom = useCallback(() => {
    scrollToBottom(chatAnimations ? undefined : { animation: "instant" })
  }, [scrollToBottom, chatAnimations])

  return (
    !isAtBottom && (
      <Button
        className={cn(
          "absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full bg-background/90 hover:bg-muted/90",
          className
        )}
        onClick={handleScrollToBottom}
        size="icon"
        type="button"
        variant="outline"
        {...props}
      >
        <ArrowDownIcon className="size-4" />
      </Button>
    )
  )
}

export interface ThreadMessage {
  role: "user" | "assistant" | "system" | "data" | "tool"
  content: string
}

export type MessageThreadDownloadProps = Omit<
  ComponentProps<typeof Button>,
  "onClick"
> & {
  messages: ThreadMessage[]
  filename?: string
  formatMessage?: (message: ThreadMessage, index: number) => string
}

const defaultFormatMessage = (message: ThreadMessage): string => {
  const roleLabel = message.role.charAt(0).toUpperCase() + message.role.slice(1)
  return `**${roleLabel}:** ${message.content}`
}

export const messagesToMarkdown = (
  messages: ThreadMessage[],
  formatMessage: (
    message: ThreadMessage,
    index: number
  ) => string = defaultFormatMessage
): string => messages.map((msg, i) => formatMessage(msg, i)).join("\n\n")

export const MessageThreadDownload = ({
  messages,
  filename = "conversation.md",
  formatMessage = defaultFormatMessage,
  className,
  children,
  ...props
}: MessageThreadDownloadProps) => {
  const handleDownload = useCallback(() => {
    const markdown = messagesToMarkdown(messages, formatMessage)
    const blob = new Blob([markdown], { type: "text/markdown" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = filename
    document.body.append(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }, [messages, filename, formatMessage])

  return (
    <Button
      className={cn(
        "absolute top-4 right-4 rounded-full dark:bg-background dark:hover:bg-muted",
        className
      )}
      onClick={handleDownload}
      size="icon"
      type="button"
      variant="outline"
      {...props}
    >
      {children ?? <DownloadIcon className="size-4" />}
    </Button>
  )
}
