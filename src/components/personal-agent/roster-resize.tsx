"use client"

/**
 * The roster's width, which the owner drags (10.1): the column keeps it —
 * the conversation beside it takes what is left, and the side panel's share
 * of the page is untouched — and the window keeps it for next time. In rem,
 * as the rows inside it are, so app zoom keeps the proportions.
 *
 * It has a least width; dragged on past it, more than halfway to the rail,
 * the list folds to its rail — the faces alone, at a width of their own —
 * and dragged out again past the same point, it unfolds. Its handle looks
 * and answers as the side panel's does (the same line, thickening under the
 * pointer and while dragged); the arrow keys move it too (past the least
 * width onto the rail, and back), and a double click puts it back.
 */

import { useCallback, useRef, useState } from "react"
import { useTranslations } from "next-intl"

import { RESIZE_HANDLE_CLASS } from "@/components/ui/resizable"
import { cn } from "@/lib/utils"

export const ROSTER_WIDTH_KEY = "pa:roster:width:v1"
/** "1" while the list is folded to its rail. */
export const ROSTER_RAIL_KEY = "pa:roster:rail:v1"
/** In rem: 240px at 100%. */
export const ROSTER_WIDTH_DEFAULT = 15
export const ROSTER_WIDTH_MIN = 12
export const ROSTER_WIDTH_MAX = 26
/** The rail's width, in rem: a face's tile and the room round it (84px at
 *  100%). */
export const ROSTER_RAIL_WIDTH = 5.25
/** A drag that wants the list narrower than this folds it to the rail, one
 *  that wants it wider unfolds it: halfway between the two. */
const RAIL_SNAP = (ROSTER_RAIL_WIDTH + ROSTER_WIDTH_MIN) / 2
/** One arrow key's step, in rem. */
const KEY_STEP = 1

/** The roster's size: its list's width, and whether it is folded. */
export interface RosterSize {
  /** In rem: the list's, unfolded (kept while folded). */
  width: number
  /** Folded to the rail. */
  rail: boolean
}

export function clampRosterWidth(width: number): number {
  if (!Number.isFinite(width)) return ROSTER_WIDTH_DEFAULT
  const w = Math.min(ROSTER_WIDTH_MAX, Math.max(ROSTER_WIDTH_MIN, width))
  return Math.round(w * 100) / 100
}

/** The width it takes now, in rem. */
export function rosterWidthOf(size: RosterSize): number {
  return size.rail ? ROSTER_RAIL_WIDTH : size.width
}

/** Where a drag that wants the roster `want` rem wide lands, from `from`. */
export function draggedSize(want: number, from: RosterSize): RosterSize {
  if (want < RAIL_SNAP) return { width: from.width, rail: true }
  return { width: clampRosterWidth(want), rail: false }
}

/** One arrow key's step wider (1) or narrower (-1): from the least width
 *  onto the rail, and off it to the least width. */
export function steppedSize(size: RosterSize, dir: 1 | -1): RosterSize {
  if (size.rail) {
    return dir > 0 ? { width: ROSTER_WIDTH_MIN, rail: false } : size
  }
  if (dir < 0 && size.width <= ROSTER_WIDTH_MIN) {
    return { width: size.width, rail: true }
  }
  return { width: clampRosterWidth(size.width + dir * KEY_STEP), rail: false }
}

function sameSize(a: RosterSize, b: RosterSize): boolean {
  return a.rail === b.rail && a.width === b.width
}

function storedSize(): RosterSize {
  try {
    const raw = window.localStorage.getItem(ROSTER_WIDTH_KEY)
    return {
      width: raw == null ? ROSTER_WIDTH_DEFAULT : clampRosterWidth(Number(raw)),
      rail: window.localStorage.getItem(ROSTER_RAIL_KEY) === "1",
    }
  } catch {
    return { width: ROSTER_WIDTH_DEFAULT, rail: false }
  }
}

function storeSize(size: RosterSize) {
  try {
    window.localStorage.setItem(ROSTER_WIDTH_KEY, String(size.width))
    if (size.rail) window.localStorage.setItem(ROSTER_RAIL_KEY, "1")
    else window.localStorage.removeItem(ROSTER_RAIL_KEY)
  } catch {
    // Not kept; this size for now all the same.
  }
}

/** The roster's size, and how to set it (kept when `keep`). */
export function useRosterWidth(): [
  RosterSize,
  (size: RosterSize, keep: boolean) => void,
] {
  const [size, setSize] = useState(storedSize)
  const set = useCallback((next: RosterSize, keep: boolean) => {
    const s = { width: clampRosterWidth(next.width), rail: next.rail }
    setSize((was) => (sameSize(was, s) ? was : s))
    if (keep) storeSize(s)
  }, [])
  return [size, set]
}

/** How many pixels a rem is now (the app zoom sets it). */
function remPx(): number {
  const px = parseFloat(getComputedStyle(document.documentElement).fontSize)
  return Number.isFinite(px) && px > 0 ? px : 16
}

/** The handle on the roster's edge toward the conversation. */
export function RosterResizeHandle({
  size,
  onSize,
}: {
  size: RosterSize
  onSize: (size: RosterSize, keep: boolean) => void
}) {
  const t = useTranslations("PersonalAgent.bots.roster")
  const [hover, setHover] = useState(false)
  const [drag, setDrag] = useState(false)
  // Where the drag began, the size and the width then, and the last size
  // set.
  const start = useRef<{
    x: number
    from: RosterSize
    width: number
    rem: number
    last: RosterSize
  } | null>(null)
  // Toward the conversation is wider: rightward, or leftward right to left.
  const sign = (el: HTMLElement): 1 | -1 =>
    getComputedStyle(el).direction === "rtl" ? -1 : 1

  const end = (el: HTMLElement, pointerId: number) => {
    const s = start.current
    start.current = null
    setDrag(false)
    document.body.style.removeProperty("cursor")
    document.body.style.removeProperty("user-select")
    if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId)
    if (s) onSize(s.last, true)
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t("resize")}
      aria-valuenow={rosterWidthOf(size)}
      aria-valuemin={ROSTER_RAIL_WIDTH}
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
        start.current = {
          x: e.clientX,
          from: size,
          width: rosterWidthOf(size),
          rem: remPx(),
          last: size,
        }
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
        const next = draggedSize(s.width + moved, s.from)
        if (sameSize(next, s.last)) return
        s.last = next
        onSize(next, false)
      }}
      onPointerUp={(e) => end(e.currentTarget, e.pointerId)}
      onPointerCancel={(e) => end(e.currentTarget, e.pointerId)}
      onDoubleClick={() =>
        onSize({ width: ROSTER_WIDTH_DEFAULT, rail: false }, true)
      }
      onKeyDown={(e) => {
        const dir =
          e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : null
        if (e.key === "Home") onSize({ width: size.width, rail: true }, true)
        else if (e.key === "End") {
          onSize({ width: ROSTER_WIDTH_MAX, rail: false }, true)
        } else if (dir != null) {
          onSize(
            steppedSize(size, dir * sign(e.currentTarget) > 0 ? 1 : -1),
            true
          )
        } else return
        e.preventDefault()
      }}
    />
  )
}
