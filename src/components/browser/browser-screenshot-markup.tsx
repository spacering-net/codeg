"use client"

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react"

import { Eraser, MoveUpRight, Square, Undo2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  drawMarkup,
  markFromDrag,
  MIN_MARK_SCREEN_PX,
  renderMarkedScreenshot,
  withMarkup,
  type MarkupMark,
  type MarkupPoint,
  type MarkupTool,
} from "@/lib/browser/screenshot-markup"
import { captureFile } from "@/lib/browser/capture-file"
import type { CaptureOutcome } from "@/lib/browser/types"
import { emitAttachPageToSession } from "@/lib/session-attachment-events"
import { cn } from "@/lib/utils"

/** What the person decided to send. */
export interface MarkedScreenshot {
  /** The picture with the marks drawn in — or null when nothing was drawn,
   *  and the capture goes over exactly as the backend encoded it rather than
   *  through a second, weaker encoder for no reason. */
  image: Blob | null
  /** The screenshot's block, with the marks described after it. */
  text: string
}

const TOOL_BUTTON = cn(
  "inline-flex h-full items-center gap-1.5 rounded-xl border border-transparent px-2.5 text-sm font-medium text-foreground/60 transition-all outline-none",
  "hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:size-4 [&_svg]:shrink-0",
  "aria-pressed:bg-background aria-pressed:text-foreground dark:aria-pressed:border-input dark:aria-pressed:bg-input/30"
)

/**
 * Boxes and arrows over a screenshot, before it goes to a conversation.
 *
 * Opened by "Mark up a screenshot…" with the capture already taken: the page
 * behind the dialog keeps living — it can scroll, navigate, redraw — and the
 * picture is the moment the person asked for, not whatever the page shows by
 * the time they finish drawing.
 *
 * Mounted only while it is open, so every opening starts from a clean sheet;
 * closing it by any route (Cancel, Escape, the close button) sends nothing —
 * including a picture that was still being made when it was closed.
 */
export function ScreenshotMarkupDialog({
  capture,
  text,
  onCancel,
  onSend,
  onFailed,
}: {
  capture: CaptureOutcome
  /** The block the backend wrote for this screenshot. */
  text: string
  onCancel: () => void
  onSend: (result: MarkedScreenshot) => void
  /** The picture could not be read: there is nothing to draw on, and the
   *  dialog is done. The caller says so. */
  onFailed: (error: unknown) => void
}) {
  const t = useTranslations("Browser.handoff")
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [tool, setTool] = useState<MarkupTool>("box")
  // Every state the marks have been in, newest last. Clearing is one more
  // state rather than a wipe, so "Clear" is as undoable as a stroke is.
  const [history, setHistory] = useState<MarkupMark[][]>([[]])
  const marks = history[history.length - 1]
  const [draft, setDraft] = useState<MarkupMark | null>(null)
  const dragRef = useRef<{ pointerId: number; start: MarkupPoint } | null>(null)
  const [sending, setSending] = useState(false)
  // Whether this sheet may still deliver. Making the picture is asynchronous,
  // and closing stays possible while it runs — Escape, the close button,
  // Cancel — so a picture finished after the person let the sheet go (or
  // after it was taken off screen) must go nowhere.
  const liveRef = useRef(true)
  useEffect(() => {
    liveRef.current = true
    return () => {
      liveRef.current = false
    }
  }, [])
  const { width, height } = capture

  const onFailedRef = useRef(onFailed)
  useEffect(() => {
    onFailedRef.current = onFailed
  }, [onFailed])

  useEffect(() => {
    let live = true
    const element = new Image()
    element.onload = () => {
      if (live) setImage(element)
    }
    element.onerror = () => {
      if (live)
        onFailedRef.current(new Error("the screenshot could not be read"))
    }
    element.src = `data:${capture.mime};base64,${capture.data}`
    return () => {
      live = false
      element.onload = null
      element.onerror = null
    }
  }, [capture.mime, capture.data])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !image) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    drawMarkup(ctx, image, draft ? [...marks, draft] : marks, {
      width,
      height,
    })
  }, [image, marks, draft, width, height])

  /** A pointer position in the picture's own pixels. The canvas is shown
   *  scaled to fit, so the screen position is read against where it actually
   *  sits — and held to its edges, so a drag that starts in the margin or runs
   *  off the picture still starts and ends on it. */
  const pointOf = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const canvas = canvasRef.current
      if (!canvas) return null
      const rect = canvas.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return null
      const x = ((event.clientX - rect.left) / rect.width) * width
      const y = ((event.clientY - rect.top) / rect.height) * height
      return {
        point: {
          x: Math.max(0, Math.min(width, x)),
          y: Math.max(0, Math.min(height, y)),
        },
        // What a few pixels on screen are in the picture's pixels.
        min: (MIN_MARK_SCREEN_PX * width) / rect.width,
      }
    },
    [width, height]
  )

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !image || sending) return
    const at = pointOf(event)
    if (!at) return
    event.preventDefault()
    // Keep the drag when the pointer leaves the picture: without the capture,
    // a box dragged past the edge would stop following at the border.
    event.currentTarget.setPointerCapture?.(event.pointerId)
    dragRef.current = { pointerId: event.pointerId, start: at.point }
    setDraft(null)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const at = pointOf(event)
    if (!at) return
    // The same threshold the release applies, so the mark on screen while
    // dragging is exactly the one that stays — nothing appears and then
    // vanishes on letting go.
    setDraft(markFromDrag(tool, drag.start, at.point, at.min))
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    setDraft(null)
    const at = pointOf(event)
    if (!at) return
    const mark = markFromDrag(tool, drag.start, at.point, at.min)
    if (!mark) return
    setHistory((past) => [...past, [...past[past.length - 1], mark]])
  }

  const dropDrag = () => {
    dragRef.current = null
    setDraft(null)
  }

  // Only the pointer that is drawing can call its drag off: another one
  // being cancelled or let go of says nothing about it.
  const dropDragOf = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dropDrag()
  }

  const undo = useCallback(() => {
    setHistory((past) => (past.length > 1 ? past.slice(0, -1) : past))
  }, [])

  const clear = useCallback(() => {
    setHistory((past) =>
      past[past.length - 1].length > 0 ? [...past, []] : past
    )
  }, [])

  const cancel = useCallback(() => {
    liveRef.current = false
    onCancel()
  }, [onCancel])

  const send = useCallback(() => {
    // Not mid-drag (⌘Enter with the pointer still down): the mark being drawn
    // is on screen but not on the sheet yet, and the picture would go without
    // it.
    if (sending || dragRef.current) return
    if (marks.length === 0) {
      onSend({ image: null, text })
      return
    }
    if (!image) return
    setSending(true)
    renderMarkedScreenshot(image, marks, { width, height }).then(
      (blob) => {
        if (!liveRef.current) return
        onSend({ image: blob, text: withMarkup(text, marks, capture) })
      },
      (error: unknown) => {
        if (!liveRef.current) return
        setSending(false)
        // The sheet stays, with everything on it: the person can try again,
        // clear the marks and send the capture as it was taken, or let it go.
        toast.error(t("failed"), { description: String(error) })
      }
    )
  }, [sending, marks, image, width, height, text, capture, onSend, t])

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!event.metaKey && !event.ctrlKey) return
    if (event.key === "Enter") {
      event.preventDefault()
      send()
    } else if (event.key.toLowerCase() === "z" && !event.shiftKey) {
      event.preventDefault()
      // The picture being made is of the marks as they were when "Add to
      // chat" was pressed; taking one away on screen now would send a
      // picture that disagrees with the sheet.
      if (!sending) undo()
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) cancel()
      }}
    >
      <DialogContent
        className="max-w-[min(1280px,calc(100vw-2rem))] gap-4 p-5"
        onKeyDown={onKeyDown}
        // Into the dialog itself rather than onto its first control: a focus
        // ring on "Box" beside a pressed "Arrow" reads as two tools chosen at
        // once. Escape, ⌘Z and ⌘Enter reach it here, and Tab still walks in.
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          if (event.target instanceof HTMLElement) event.target.focus()
        }}
        // Escape mid-drag drops the mark being drawn, not everything drawn.
        onEscapeKeyDown={(event) => {
          if (!dragRef.current) return
          event.preventDefault()
          dropDrag()
        }}
        // A stray click beside the picture must not throw the marks away.
        onPointerDownOutside={(event) => {
          if (marks.length > 0) event.preventDefault()
        }}
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>{t("markupTitle")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label={t("markupTools")}
            className="inline-flex h-9 items-center rounded-4xl bg-muted p-[3px]"
          >
            <button
              type="button"
              className={TOOL_BUTTON}
              aria-pressed={tool === "box"}
              onClick={() => setTool("box")}
            >
              <Square />
              {t("markupBox")}
            </button>
            <button
              type="button"
              className={TOOL_BUTTON}
              aria-pressed={tool === "arrow"}
              onClick={() => setTool("arrow")}
            >
              <MoveUpRight />
              {t("markupArrow")}
            </button>
          </div>
          <div className="ms-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={undo}
              disabled={history.length <= 1 || sending}
            >
              <Undo2 />
              {t("markupUndo")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={clear}
              disabled={marks.length === 0 || sending}
            >
              <Eraser />
              {t("markupClear")}
            </Button>
          </div>
        </div>
        {/* The whole well is the drawing surface, not just the picture in it:
            a box around something at the picture's edge is easiest started
            just outside it, and the picture's own rounded corners would
            otherwise turn a press right on the corner into nothing. */}
        <div
          className="flex min-h-0 min-w-0 cursor-crosshair touch-none items-center justify-center rounded-2xl bg-muted/40 p-2 select-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={dropDragOf}
          onLostPointerCapture={dropDragOf}
        >
          <canvas
            ref={canvasRef}
            width={width}
            height={height}
            role="img"
            aria-label={t("markupTitle")}
            className="block h-auto max-h-[calc(100dvh-15rem)] w-auto max-w-full rounded-lg shadow-sm ring-1 ring-border"
          />
        </div>
        <DialogFooter className="items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {marks.length > 0
              ? t("markupCount", { count: marks.length })
              : t("markupHint")}
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="outline" onClick={cancel}>
              {t("markupCancel")}
            </Button>
            <Button onClick={send} disabled={sending || !image}>
              {t("markupSend")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Where the dialog lives.
//
// Not in the tab it was opened from. Only the browser tab on screen is
// mounted, and the one on screen can change while someone draws without them
// touching anything: a local server starting opens a tab of its own, and so
// can an agent. A dialog inside the old tab's toolbar would vanish with it and
// take the marks along. So the toolbar hands the capture here, and a host
// mounted once in the workspace shows it until the person sends it or lets it
// go.

/** A screenshot waiting to be marked up, and where it goes after. */
export interface ScreenshotMarkupRequest {
  capture: CaptureOutcome
  /** The block the backend wrote for this screenshot. */
  text: string
  /** Where the page was, with anything secret-looking already taken out. */
  uri: string
  /** The conversation it was taken for — not whichever is active by the
   *  time the person has finished drawing. */
  conversationTabId: string
}

interface PendingMarkup {
  id: number
  request: ScreenshotMarkupRequest
}

let pending: PendingMarkup | null = null
let lastId = 0
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Show the markup dialog for this capture — unless one is already up.
 *
 *  One sheet at a time, and the one on screen wins. The dialog covers the
 *  toolbar once it is up, so the only way to ask for a second is to pick the
 *  entry again while the first capture was still on its way — and replacing
 *  the sheet then would throw away whatever had been drawn on it. */
export function openScreenshotMarkup(request: ScreenshotMarkupRequest): void {
  if (pending) return
  lastId += 1
  pending = { id: lastId, request }
  notify()
}

/** Done with this one. Named by id, so an answer arriving from a sheet that
 *  is already gone cannot close the one showing now. */
function closeScreenshotMarkup(id: number): void {
  if (pending?.id !== id) return
  pending = null
  notify()
}

export function resetScreenshotMarkupForTests(): void {
  pending = null
  notify()
}

/** A marked-up picture as a file for the composer, named for what it is. */
function markedFile(image: Blob): File {
  const extension = image.type === "image/jpeg" ? "jpg" : "png"
  return new File([image], `marked-screenshot.${extension}`, {
    type: image.type || "image/png",
  })
}

/** Mounted once in the workspace; shows the markup dialog while there is a
 *  screenshot waiting for one. */
export function BrowserScreenshotMarkupHost() {
  const t = useTranslations("Browser.handoff")
  const current = useSyncExternalStore(
    subscribe,
    () => pending,
    () => null
  )
  if (!current) return null
  const { id, request } = current
  return (
    <ScreenshotMarkupDialog
      // Each capture gets a sheet of its own, never the last one's marks.
      key={id}
      capture={request.capture}
      text={request.text}
      onCancel={() => closeScreenshotMarkup(id)}
      onFailed={(error) => {
        closeScreenshotMarkup(id)
        toast.error(t("failed"), { description: String(error) })
      }}
      onSend={(result) => {
        closeScreenshotMarkup(id)
        // A composer that is gone hears nothing, and the event says whether
        // one took it — so "added to the chat" is never said about a picture
        // that went nowhere.
        const accepted = emitAttachPageToSession({
          tabId: request.conversationTabId,
          label: result.image ? t("chipMarkedScreenshot") : t("chipScreenshot"),
          text: result.text,
          uri: request.uri,
          image: result.image
            ? markedFile(result.image)
            : captureFile(request.capture, "screenshot"),
        })
        if (accepted) toast.success(t("sent"))
        else toast.error(t("gone"))
      }}
    />
  )
}
