"use client"

import { useEffect } from "react"
import { subscribe, onTransportReconnect } from "@/lib/platform"
import {
  CANVAS_CHANGED_EVENT,
  type CanvasChange,
  type CanvasNode,
} from "@/lib/types"
import { useCanvasStore } from "@/stores/canvas-store"

/**
 * Wires the canvas store to the backend while a board is on screen: point the
 * store at the board, subscribe FIRST, fetch the snapshot only once the
 * listener is live (the tab-context handshake) — a mutation committed between a
 * snapshot read and the subscription going live would otherwise be dropped by
 * the broadcaster and only surface as a gap much later. A transport reconnect
 * refetches, which also covers events lost while the socket was down.
 *
 * Mounted per board visit (not app-wide): the canvas is a full-page route and
 * one board is shown at a time, so keeping a node set hot while it's closed
 * buys nothing. Leaving closes the board in the store, which is what stops a
 * failed fetch from retrying behind a view that is gone.
 */
export function useCanvasData(boardId: number): void {
  useEffect(() => {
    useCanvasStore.getState().openBoard(boardId)
    let disposed = false
    let unlisten: (() => void) | undefined
    void (async () => {
      const dispose = await subscribe<CanvasChange>(
        CANVAS_CHANGED_EVENT,
        (change) => useCanvasStore.getState().handleCanvasChanged(change)
      )
      if (disposed) {
        dispose()
        return
      }
      unlisten = dispose
      void useCanvasStore.getState().refetch()
    })()
    const offReconnect = onTransportReconnect(() =>
      useCanvasStore.getState().refetch()
    )
    return () => {
      disposed = true
      unlisten?.()
      offReconnect?.()
      // Only if the store still holds THIS board: closing is about this
      // board's fetches, and must never strand the next board's if its view
      // got the store first.
      if (useCanvasStore.getState().boardId === boardId) {
        useCanvasStore.getState().closeBoard()
      }
    }
  }, [boardId])
}

const NO_NODES: ReadonlyMap<number, CanvasNode> = new Map()

/**
 * The store's view of `boardId`, and nothing else.
 *
 * The store is pointed at a board from an EFFECT, so the first render of a
 * board still sees whatever the store held before — the previous board's
 * nodes, flagged hydrated. Reading those as this board's would paint the wrong
 * canvas for a frame, and worse, every "drop remembered ids whose node is gone"
 * pass would run against the wrong board and wipe this one's saved state. Until
 * the store says it holds this board, it holds nothing.
 */
export function useBoardNodes(boardId: number): {
  nodes: ReadonlyMap<number, CanvasNode>
  hydrated: boolean
  missing: boolean
} {
  const nodes = useCanvasStore((s) =>
    s.boardId === boardId ? s.nodes : NO_NODES
  )
  const hydrated = useCanvasStore((s) => s.boardId === boardId && s.hydrated)
  const missing = useCanvasStore((s) => s.boardId === boardId && s.boardMissing)
  return { nodes, hydrated, missing }
}
