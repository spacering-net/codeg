"use client"

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react"

/** How far a press must travel vertically (px) before it becomes a drag. */
const DRAG_THRESHOLD_PX = 4

/** Rows opt in with this attribute; its value is the conversation id. */
export const PINNED_ROW_ATTR = "data-pinned-row-id"

/**
 * The pinned order after dropping `draggedId` at `dropIndex` — an insertion
 * index into the CURRENT order (0 = before the first row, `ids.length` = after
 * the last). Null when the drop changes nothing.
 */
export function reorderedPinIds(
  ids: readonly number[],
  draggedId: number,
  dropIndex: number
): number[] | null {
  const from = ids.indexOf(draggedId)
  if (from === -1) return null
  const next = ids.filter((id) => id !== draggedId)
  // Taking the dragged row out shifts every slot below it up by one.
  const to = Math.max(
    0,
    Math.min(dropIndex > from ? dropIndex - 1 : dropIndex, next.length)
  )
  next.splice(to, 0, draggedId)
  return next.every((id, i) => id === ids[i]) ? null : next
}

/** A pinned row as laid out on screen: its id and vertical midpoint. */
export interface PinnedRowBox {
  id: number
  midY: number
}

/**
 * Insertion index into `ids` (the section's full order) for a pointer at
 * `clientY`, given the pinned rows that are currently mounted. The sidebar list
 * is virtualized, so rows scrolled far out of view may be missing; counting on
 * from the first mounted row's own position keeps the index true to the full
 * order. Null when no pinned row is mounted.
 */
export function pinInsertionIndex(
  ids: readonly number[],
  rows: readonly PinnedRowBox[],
  clientY: number
): number | null {
  let first = Infinity
  let above = 0
  for (const row of rows) {
    const index = ids.indexOf(row.id)
    if (index === -1) continue
    first = Math.min(first, index)
    if (row.midY < clientY) above += 1
  }
  return first === Infinity ? null : first + above
}

/** {@link pinInsertionIndex} against the pinned rows currently in the DOM. */
function dropIndexAt(ids: readonly number[], clientY: number): number | null {
  const rows = Array.from(
    document.querySelectorAll<HTMLElement>(`[${PINNED_ROW_ATTR}]`),
    (row) => {
      const box = row.getBoundingClientRect()
      return {
        id: Number(row.getAttribute(PINNED_ROW_ATTR)),
        midY: box.top + box.height / 2,
      }
    }
  )
  return pinInsertionIndex(ids, rows, clientY)
}

/**
 * Swallow the click the browser fires right after the pointerup that ends a
 * drag, so the drop does not also open the conversation under the pointer. If
 * no click follows (a release outside the window), the listener is dropped on
 * the next task instead of eating a later, real click.
 */
function swallowNextClick() {
  const swallow = (event: MouseEvent) => {
    event.stopPropagation()
    event.preventDefault()
  }
  window.addEventListener("click", swallow, { capture: true, once: true })
  setTimeout(() => window.removeEventListener("click", swallow, true), 0)
}

interface PressState {
  id: number
  pointerId: number
  startY: number
  started: boolean
}

/**
 * Drag-to-reorder for the sidebar's "Pinned" section, driven by pointer events.
 *
 * Not HTML5 drag-and-drop: in the desktop app a drag over the webview is handed
 * to Tauri's native drag-drop handler (the one that takes files dropped into
 * the composer), and WebKit then never delivers the target-side `dragover` /
 * `drop` to the page — only `dragstart` / `dragend` arrive. An HTML5 reorder
 * would therefore only ever work in a browser. Pointer events always reach the
 * page, which is why the folder reorder is built on them too.
 *
 * A press becomes a drag only once the pointer has moved
 * {@link DRAG_THRESHOLD_PX} vertically, so a plain click still opens the
 * conversation, and the click that ends a real drag is swallowed. Escape
 * cancels. Mouse and pen only: on touch the same gesture scrolls the list.
 */
export function usePinnedPointerReorder({
  pinnedIds,
  onCommit,
}: {
  /** The Pinned section's current order, top to bottom. */
  pinnedIds: readonly number[]
  /** Called once per finished drag that changes the order. */
  onCommit: (orderedIds: number[]) => void
}) {
  // The row being dragged and the insertion index it would drop at; both null
  // while no drag is in progress.
  const [draggingId, setDraggingId] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)

  // Read at event time, so the window listeners never act on a stale order.
  const pinnedIdsRef = useRef(pinnedIds)
  const onCommitRef = useRef(onCommit)
  useEffect(() => {
    pinnedIdsRef.current = pinnedIds
    onCommitRef.current = onCommit
  }, [pinnedIds, onCommit])

  const pressRef = useRef<PressState | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)

  const finish = useCallback(() => {
    cleanupRef.current?.()
    cleanupRef.current = null
    pressRef.current = null
    setDraggingId(null)
    setDropIndex(null)
  }, [])
  // Safety net: drop the window listeners if the list unmounts mid-drag.
  useEffect(() => finish, [finish])

  const beginPinDrag = useCallback(
    (id: number, event: ReactPointerEvent) => {
      if (event.button !== 0 || event.pointerType === "touch") return
      if (pressRef.current) return
      const target = event.target as Element
      // React bubbles events out of portals, so a press inside the row's
      // context menu, hover card or dialogs arrives here too — only a press on
      // the row itself may start a drag.
      if (!event.currentTarget.contains(target)) return
      // The row's own controls (expand, pin, status) stay plain buttons. The
      // row body is a <button> as well — the one carrying
      // `data-conversation-id` — and that one is the drag handle.
      const control = target.closest("button, a, input, textarea")
      if (control && !control.hasAttribute("data-conversation-id")) return

      pressRef.current = {
        id,
        pointerId: event.pointerId,
        startY: event.clientY,
        started: false,
      }
      const prevUserSelect = document.body.style.userSelect

      const onMove = (e: PointerEvent) => {
        const press = pressRef.current
        if (!press || e.pointerId !== press.pointerId) return
        if (!press.started) {
          if (Math.abs(e.clientY - press.startY) < DRAG_THRESHOLD_PX) return
          press.started = true
          document.body.style.userSelect = "none"
          setDraggingId(press.id)
        }
        setDropIndex(dropIndexAt(pinnedIdsRef.current, e.clientY))
      }
      const onUp = (e: PointerEvent) => {
        const press = pressRef.current
        if (!press || e.pointerId !== press.pointerId) return
        let next: number[] | null = null
        if (press.started) {
          swallowNextClick()
          const ids = pinnedIdsRef.current
          const index = dropIndexAt(ids, e.clientY)
          if (index != null) next = reorderedPinIds(ids, press.id, index)
        }
        finish()
        if (next) onCommitRef.current(next)
      }
      const onCancel = (e: PointerEvent) => {
        if (e.pointerId === pressRef.current?.pointerId) finish()
      }
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape" && pressRef.current?.started) finish()
      }
      window.addEventListener("pointermove", onMove)
      window.addEventListener("pointerup", onUp)
      window.addEventListener("pointercancel", onCancel)
      window.addEventListener("keydown", onKeyDown)
      cleanupRef.current = () => {
        window.removeEventListener("pointermove", onMove)
        window.removeEventListener("pointerup", onUp)
        window.removeEventListener("pointercancel", onCancel)
        window.removeEventListener("keydown", onKeyDown)
        document.body.style.userSelect = prevUserSelect
      }
    },
    [finish]
  )

  return { draggingId, dropIndex, beginPinDrag }
}
