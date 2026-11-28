"use client"

/**
 * The side panel's width, kept as the conversation page keeps its side
 * columns': in px, as the owner last dragged it, so the page comes back
 * with it — and a window resized keeps it too, the conversation taking the
 * difference. The panel group still sizes in shares of its width
 * (react-resizable-panels): the px are turned into one for the width the
 * group has, within the panels' own bounds. Only a drag of the handle
 * changes what is kept; nothing kept yet, the panel opens at its default
 * share.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import type { ImperativePanelGroupHandle } from "react-resizable-panels"

const STORAGE_KEY = "personal-agent:aux-width"

/** The panel's share when nothing is kept, and its bounds — the
 *  conversation's minimum leaving it the rest. */
export const AUX_DEFAULT_SIZE = 30
export const AUX_MIN_SIZE = 22
export const MAIN_MIN_SIZE = 45

/** The handle between them: a fixed 1px the panels' shares leave out. */
const HANDLE_PX = 1

function loadWidth(): number | null {
  try {
    const v = Number(window.localStorage.getItem(STORAGE_KEY))
    return Number.isFinite(v) && v > 0 ? v : null
  } catch {
    return null
  }
}

function saveWidth(px: number) {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(Math.round(px)))
  } catch {
    /* ignore */
  }
}

/** The share `px` is of `total`, within the panel's bounds. */
export function auxShareOf(px: number, total: number): number {
  const share = (px / total) * 100
  return Math.min(100 - MAIN_MIN_SIZE, Math.max(AUX_MIN_SIZE, share))
}

export function useAuxWidth(open: boolean) {
  const groupRef = useRef<ImperativePanelGroupHandle | null>(null)
  // The element the panels share, as it mounts: the page draws a skeleton
  // first, the panels only once the assistant is read.
  const [container, containerRef] = useState<HTMLDivElement | null>(null)
  const dragging = useRef(false)
  const [kept, setKept] = useState<number | null>(null)
  const [total, setTotal] = useState(0)

  // Read once the page is in the browser (a static export renders it
  // first without one).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- browser-only localStorage read after mount (hydration-safe)
    setKept(loadWidth())
  }, [])

  // The width the panels share, as it changes.
  useEffect(() => {
    const el = container
    if (!el) return
    const measure = (w: number) =>
      setTotal(Math.max(0, Math.round(w) - HANDLE_PX))
    measure(el.clientWidth)
    const observer = new ResizeObserver((entries) => {
      measure(entries[0]?.contentRect.width ?? el.clientWidth)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [container])

  const share =
    kept != null && total > 0 ? auxShareOf(kept, total) : AUX_DEFAULT_SIZE

  // The kept px laid out for the width there is — as the panel opens and as
  // the window changes; not under a drag, which is the owner's.
  useLayoutEffect(() => {
    const group = groupRef.current
    if (!open || !group || dragging.current) return
    const layout = group.getLayout()
    if (layout.length !== 2 || Math.abs(layout[1] - share) < 0.05) return
    try {
      group.setLayout([100 - share, share])
    } catch {
      /* the group not ready: its default share stands */
    }
  }, [open, share])

  // A drag over: what it left is kept.
  const onDragging = useCallback(
    (on: boolean) => {
      dragging.current = on
      if (on || total <= 0) return
      const layout = groupRef.current?.getLayout()
      if (!layout || layout.length !== 2) return
      const px = (layout[1] / 100) * total
      saveWidth(px)
      setKept(px)
    },
    [total]
  )

  return { groupRef, containerRef, share, onDragging }
}
