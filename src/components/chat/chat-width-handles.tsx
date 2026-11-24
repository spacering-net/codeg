"use client"

import { useCallback, useRef, useState } from "react"
import type {
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from "react"
import { useTranslations } from "next-intl"

import { useChatContentWidth } from "@/hooks/use-appearance"
import {
  CHAT_CONTENT_MIN,
  chatZoomFactor,
  maxChatContentWidth,
  resizedChatContentWidth,
} from "@/lib/chat-content-width"
import { cn } from "@/lib/utils"

/**
 * Width change per arrow-key press, in px at 100% zoom (split across both
 * sides).
 */
const KEY_STEP = 32

const WHEEL_DELTA_LINE = 1
const WHEEL_DELTA_PAGE = 2
const FALLBACK_WHEEL_LINE_PX = 16

type Side = "left" | "right"

// Where the content edge sits inside the (relative) host: the same `min()` the
// `chat-content-w` utility resolves, so the handle tracks the column exactly.
const EDGE_OFFSET =
  "min(var(--chat-content-width, 48rem), 100% - 2 * var(--chat-gutter, 0px)) / 2"

function wheelDeltaY(event: ReactWheelEvent, scrollport: HTMLElement): number {
  if (event.deltaMode === WHEEL_DELTA_LINE) {
    const lineHeight = Number.parseFloat(
      getComputedStyle(scrollport).lineHeight
    )
    return (
      event.deltaY *
      (Number.isFinite(lineHeight) ? lineHeight : FALLBACK_WHEEL_LINE_PX)
    )
  }
  if (event.deltaMode === WHEEL_DELTA_PAGE) {
    return event.deltaY * scrollport.clientHeight
  }
  return event.deltaY
}

/**
 * The scroller under the handles: the transcript's scrollport, or — on the
 * new-conversation welcome page, which has no transcript yet — the viewport of
 * its overlay-scrollbar area (the first one in the host is the outermost).
 */
function scrollPortIn(host: HTMLElement): HTMLElement | null {
  return (
    host.querySelector<HTMLElement>(".chat-scroll-port") ??
    host.querySelector<HTMLElement>("[data-overlayscrollbars-viewport]")
  )
}

interface Measured {
  /** The column's visible width, px at 100% zoom. */
  width: number
  /** The host's width in CSS px. */
  hostWidth: number
  /** The app zoom as a factor (CSS px per px at 100% zoom). */
  zoom: number
}

/**
 * The content column as it stands, read off this handle's own position. Each
 * handle hangs INSIDE the column from its edge (see the render), so the edge is
 * the handle's outer side. Layout is in CSS px, which the app zoom scales, so
 * the width is brought back to px at 100% zoom — the unit everything is stored
 * in.
 */
function measure(handle: HTMLElement, side: Side): Measured | null {
  const host = handle.parentElement
  if (!host) return null
  const hostBox = host.getBoundingClientRect()
  const handleBox = handle.getBoundingClientRect()
  const hostCenter = hostBox.left + hostBox.width / 2
  const edge = side === "left" ? handleBox.left : handleBox.right
  const zoom = chatZoomFactor()
  return {
    width: (Math.abs(edge - hostCenter) * 2) / zoom,
    hostWidth: hostBox.width,
    zoom,
  }
}

interface Readout {
  now: number
  min: number
  max: number
}

/** `aria-value*` for the separator: the visible width and its range here. */
function readoutOf({ width, hostWidth, zoom }: Measured): Readout {
  const now = Math.round(width)
  return {
    now,
    min: Math.min(CHAT_CONTENT_MIN, now),
    max: Math.max(now, Math.floor(maxChatContentWidth(hostWidth, zoom))),
  }
}

interface DragState {
  pointerId: number
  originX: number
  latestX: number
  frame: number | null
  /** The column's width when the press began, px at 100% zoom. */
  baseWidth: number
  zoom: number
}

/** What dragging `side` from the press to the pointer asks to store. */
function draggedWidth(
  state: DragState,
  side: Side,
  host: HTMLElement
): number | null {
  if (state.latestX === state.originX) return null
  const dx = (state.latestX - state.originX) / state.zoom
  const outward = side === "right" ? dx : -dx
  return resizedChatContentWidth(
    state.baseWidth,
    state.baseWidth + outward * 2,
    host.getBoundingClientRect().width,
    state.zoom
  )
}

function WidthHandle({ side }: { side: Side }) {
  const t = useTranslations("Folder.chat.messageList")
  const { setChatContentWidth, previewChatContentWidth, getChatContentWidth } =
    useChatContentWidth()
  const drag = useRef<DragState | null>(null)
  // Measured when the handle takes focus (and after each key), so a screen
  // reader hears the width; nothing reads layout for a pointer user.
  const [readout, setReadout] = useState<Readout | null>(null)

  const endDrag = useCallback((handle: HTMLElement) => {
    const state = drag.current
    if (!state) return
    if (state.frame !== null) cancelAnimationFrame(state.frame)
    drag.current = null
    handle.toggleAttribute("data-dragging", false)
  }, [])

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      const handle = event.currentTarget
      const measured = measure(handle, side)
      if (!measured) return
      event.preventDefault()
      handle.setPointerCapture(event.pointerId)
      drag.current = {
        pointerId: event.pointerId,
        originX: event.clientX,
        latestX: event.clientX,
        frame: null,
        baseWidth: measured.width,
        zoom: measured.zoom,
      }
      handle.toggleAttribute("data-dragging", true)
    },
    [side]
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = drag.current
      const host = event.currentTarget.parentElement
      if (!state || !host || state.pointerId !== event.pointerId) return
      state.latestX = event.clientX
      state.frame ??= requestAnimationFrame(() => {
        state.frame = null
        // Nothing to store from here → show the stored width, not a stale
        // frame of an earlier position.
        previewChatContentWidth(
          draggedWidth(state, side, host) ?? getChatContentWidth()
        )
      })
    },
    [side, previewChatContentWidth, getChatContentWidth]
  )

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = drag.current
      const handle = event.currentTarget
      const host = handle.parentElement
      if (!state || !host || state.pointerId !== event.pointerId) return
      state.latestX = event.clientX
      // Null for a press-and-release without moving (the default must not be
      // frozen into storage as a chosen width) and for a drag the host cannot
      // show (see `resizedChatContentWidth`).
      const next = draggedWidth(state, side, host)
      endDrag(handle)
      if (next === null) previewChatContentWidth(getChatContentWidth())
      else setChatContentWidth(next)
    },
    [
      endDrag,
      side,
      setChatContentWidth,
      previewChatContentWidth,
      getChatContentWidth,
    ]
  )

  // Also wired to `lostpointercapture`, which follows every `pointerup`; the
  // drag is already over by then, so only a real interruption gets here with
  // one live. Its frames previewed widths that were never stored: put the
  // stored one back — as stored NOW, which may be another window's newer
  // width, not the one this render saw.
  const onPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!drag.current) return
      endDrag(event.currentTarget)
      previewChatContentWidth(getChatContentWidth())
    },
    [endDrag, previewChatContentWidth, getChatContentWidth]
  )

  const onDoubleClick = useCallback(() => {
    setChatContentWidth(null)
  }, [setChatContentWidth])

  const onFocus = useCallback(
    (event: ReactFocusEvent<HTMLDivElement>) => {
      const measured = measure(event.currentTarget, side)
      if (measured) setReadout(readoutOf(measured))
    },
    [side]
  )

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const handle = event.currentTarget
      if (event.key === "Escape" || event.key === "Home") {
        event.preventDefault()
        setChatContentWidth(null)
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const measured = measure(handle, side)
        if (!measured) return
        event.preventDefault()
        // The key that moves the handle outward widens the column.
        const outwardKey = side === "right" ? "ArrowRight" : "ArrowLeft"
        const delta = event.key === outwardKey ? KEY_STEP : -KEY_STEP
        const next = resizedChatContentWidth(
          measured.width,
          measured.width + delta,
          measured.hostWidth,
          measured.zoom
        )
        if (next !== null) setChatContentWidth(next)
      } else {
        return
      }
      // The width is on <html> already (the setter applies it in place).
      const measured = measure(handle, side)
      if (measured) setReadout(readoutOf(measured))
    },
    [side, setChatContentWidth]
  )

  // The handle lies over the transcript but outside its scrollport, so a
  // wheel over it reaches neither the scroller nor the scroller's own wheel
  // listeners. Among those is the stick-to-bottom escape
  // (`EscapeLockOnUserScroll`): without it, scrolling up while a reply streams
  // is pulled straight back down, because the library drops scroll events that
  // land during a content resize. So replay the wheel on the scrollport first —
  // untrusted, it moves nothing by itself, and it does not bubble, so nothing
  // above the port hears it twice — and then do the scrolling.
  const onWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    if (event.ctrlKey) return
    const host = event.currentTarget.parentElement
    const port = host ? scrollPortIn(host) : null
    if (!port) return
    port.dispatchEvent(
      new WheelEvent("wheel", {
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaZ: event.deltaZ,
        deltaMode: event.deltaMode,
        clientX: event.clientX,
        clientY: event.clientY,
        screenX: event.screenX,
        screenY: event.screenY,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
      })
    )
    if (event.deltaY !== 0) {
      port.scrollBy({ top: wheelDeltaY(event, port) })
    }
  }, [])

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t("resizeWidth")}
      aria-valuenow={readout?.now}
      aria-valuemin={readout?.min}
      aria-valuemax={readout?.max}
      title={t("resizeWidth")}
      tabIndex={0}
      data-width-handle={side}
      // Hangs inward from the column edge: the 12px hit zone lies over the
      // rows' own px-4 padding (no text under it) and, with the shell's
      // gutter, never reaches the window border.
      className={cn(
        "group absolute inset-y-0 z-10 hidden w-3 cursor-col-resize touch-none select-none outline-none md:block",
        side === "right" && "-translate-x-full"
      )}
      style={{
        left:
          side === "left"
            ? `calc(50% - ${EDGE_OFFSET})`
            : `calc(50% + ${EDGE_OFFSET})`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
      onDoubleClick={onDoubleClick}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      onWheel={onWheel}
    >
      <span
        className={cn(
          "absolute inset-y-0 w-px bg-transparent transition-colors group-hover:bg-border group-focus-visible:bg-ring group-data-[dragging]:bg-primary/60",
          side === "left" ? "left-0" : "right-0"
        )}
      />
    </div>
  )
}

/**
 * Two drag handles on the left/right edges of the chat column. Dragging either
 * outward widens the column symmetrically (width = start + 2 × outward travel);
 * double-click (or Esc/Home) restores the default. The width is a global
 * preference: it lives on `<html>` as `--chat-content-width`, so every
 * transcript and composer in the app follows it. Must be mounted inside a
 * `relative` host that spans the transcript, with no transform between it and
 * the viewport: the drag maths reads layout boxes and pointer positions as the
 * CSS px they are in an unscaled tree (`ConversationShell` mounts these only
 * for the conversation tab, never inside a zoomed canvas card).
 */
export function ChatWidthHandles() {
  return (
    <>
      <WidthHandle side="left" />
      <WidthHandle side="right" />
    </>
  )
}
