import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { CanvasNode } from "@/lib/types"
import { useCanvasStore } from "@/stores/canvas-store"
import { useBoardNodes } from "./canvas-data"

vi.mock("@/lib/api", () => ({ canvasListNodes: vi.fn() }))

function note(id: number, boardId: number): CanvasNode {
  return {
    id,
    board_id: boardId,
    kind: "note",
    folder_id: null,
    folder_group_id: null,
    agent_type: null,
    conversation_id: null,
    member_ids: [],
    title: null,
    content: null,
    path: null,
    color: null,
    collapsed: false,
    grid_columns: 0,
    grid_rows: 0,
    x: 0,
    y: 0,
    width: 200,
    height: 140,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
  }
}

beforeEach(() => {
  useCanvasStore.getState().reset()
})

describe("useBoardNodes", () => {
  it("reads nothing while the store still holds another board", () => {
    // The first render of a board happens BEFORE its effect points the store
    // at it. Handing that render the previous board's hydrated nodes would
    // paint the wrong canvas, and let the view's "drop remembered ids whose
    // node is gone" pass wipe this board's saved state against them.
    const store = useCanvasStore.getState()
    store.openBoard(1)
    store.acceptSnapshot({ board_id: 1, revision: 3, nodes: [note(10, 1)] })

    const { result } = renderHook(() => useBoardNodes(2))
    expect(result.current.hydrated).toBe(false)
    expect(result.current.nodes.size).toBe(0)
    expect(result.current.missing).toBe(false)

    act(() => {
      useCanvasStore.getState().openBoard(2)
      useCanvasStore.getState().acceptSnapshot({
        board_id: 2,
        revision: 4,
        nodes: [note(20, 2)],
      })
    })
    expect(result.current.hydrated).toBe(true)
    expect([...result.current.nodes.keys()]).toEqual([20])
  })

  it("reports a missing board only for its own board", () => {
    act(() => {
      useCanvasStore.getState().openBoard(1)
      useCanvasStore.setState({ boardMissing: true })
    })
    expect(renderHook(() => useBoardNodes(1)).result.current.missing).toBe(true)
    expect(renderHook(() => useBoardNodes(2)).result.current.missing).toBe(
      false
    )
  })
})
