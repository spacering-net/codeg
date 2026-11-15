"use client"

/**
 * The roster's width, which the owner drags (10.1): the column keeps it —
 * the conversation beside it takes what is left, and the side panel's share
 * of the page is untouched — and the window keeps it for next time. In rem,
 * as the rows inside it are, so app zoom keeps the proportions. Its handle
 * looks and answers as the side panel's does (the same line, thickening
 * under the pointer and while dragged); the arrow keys move it too, and a
 * double click puts it back.
 */

import { useCallback, useRef, useState } from "react"
import { useTranslations } from "next-intl"

import { RESIZE_HANDLE_CLASS } from "@/components/ui/resizable"
import { cn } from "@/lib/utils"

export const ROSTER_WIDTH_KEY = "pa:roster:width:v1"
/** In rem: 240px at 100%. */
export const ROSTER_WIDTH_DEFAULT = 15
export const ROSTER_WIDTH_MIN = 12
export const ROSTER_WIDTH_MAX = 26
/** One arrow key's step, in rem. */
const KEY_STEP = 1

export function clampRosterWidth(width: number): number {
  if (!Number.isFinite(width)) return ROSTER_WIDTH_DEFAULT
  const w = Math.min(ROSTER_WIDTH_MAX, Math.max(ROSTER_WIDTH_MIN, width))
  return Math.round(w * 100) / 100
}

function storedWidth(): number {
  try {
    const raw = window.localStorage.getItem(ROSTER_WIDTH_KEY)
    return raw == null ? ROSTER_WIDTH_DEFAULT : clampRosterWidth(Number(raw))
  } catch {
    return ROSTER_WIDTH_DEFAULT
  }
}

function storeWidth(width: number) {
  try {
    window.localStorage.setItem(ROSTER_WIDTH_KEY, String(width))
  } catch {
    // Not kept; this width for now all the same.
  }
}

/** The roster's width in rem, and how to set it (kept when `keep`). */
export function useRosterWidth(): [
  number,
  (width: number, keep: boolean) => void,
] {
  const [width, setWidth] = useState(storedWidth)
  const set = useCallback((next: number, keep: boolean) => {
    const w = clampRosterWidth(next)
    setWidth(w)
    if (keep) storeWidth(w)
  }, [])
  return [width, set]
}

/** How many pixels a rem is now (the app zoom sets it). */
function remPx(): number {
  const px = parseFloat(getComputedStyle(document.documentElement).fontSize)
  return Number.isFinite(px) && px > 0 ? px : 16
}

/** The handle on the roster's edge toward the conversation. */
export function RosterResizeHandle({
  width,
  onWidth,
}: {
  /** In rem. */
  width: number
  onWidth: (width: number, keep: boolean) => void
}) {
  const t = useTranslations("PersonalAgent.bots.roster")
  const [hover, setHover] = useState(false)
  const [drag, setDrag] = useState(false)
  // Where the drag began, the width then, and the last one set.
  const start = useRef<{
    x: number
    width: number
    rem: number
    last: number
  } | null>(null)
  // Toward the conversation is wider: rightward, or leftward right to left.
  const sign = (el: HTMLElement) =>
    getComputedStyle(el).direction === "rtl" ? -1 : 1

  const end = (el: HTMLElement, pointerId: number) => {
    const s = start.current
    start.current = null
    setDrag(false)
    document.body.style.removeProperty("cursor")
    document.body.style.removeProperty("user-select")
    if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId)
    if (s) onWidth(s.last, true)
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t("resize")}
      aria-valuenow={width}
      aria-valuemin={ROSTER_WIDTH_MIN}
      aria-valuemax={ROSTER_WIDTH_MAX}
      tabIndex={0}
      data-pa-roster-resize
      data-resize-handle-state={drag ? "drag" : hover ? "hover" : "inactive"}
      className={cn(RESIZE_HANDLE_CLASS, "shrink-0 cursor-col-resize")}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = { x: e.clientX, width, rem: remPx(), last: width }
        setDrag(true)
        // The whole page drags: no text selected on the way, the cursor
        // the same wherever the pointer goes.
        document.body.style.setProperty("cursor", "col-resize")
        document.body.style.setProperty("user-select", "none")
      }}
      onPointerMove={(e) => {
        const s = start.current
        if (!s) return
        const moved = ((e.clientX - s.x) / s.rem) * sign(e.currentTarget)
        const next = clampRosterWidth(s.width + moved)
        if (next === s.last) return
        s.last = next
        onWidth(next, false)
      }}
      onPointerUp={(e) => end(e.currentTarget, e.pointerId)}
      onPointerCancel={(e) => end(e.currentTarget, e.pointerId)}
      onDoubleClick={() => onWidth(ROSTER_WIDTH_DEFAULT, true)}
      onKeyDown={(e) => {
        const step =
          e.key === "ArrowRight"
            ? KEY_STEP
            : e.key === "ArrowLeft"
              ? -KEY_STEP
              : 0
        if (e.key === "Home") onWidth(ROSTER_WIDTH_MIN, true)
        else if (e.key === "End") onWidth(ROSTER_WIDTH_MAX, true)
        else if (step !== 0) onWidth(width + step * sign(e.currentTarget), true)
        else return
        e.preventDefault()
      }}
    />
  )
}
