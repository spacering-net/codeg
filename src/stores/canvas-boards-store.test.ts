import { beforeEach, describe, expect, it, vi } from "vitest"
import { canvasListBoards } from "@/lib/api"
import type { CanvasBoard, CanvasBoardSummary } from "@/lib/types"
import { useCanvasBoardsStore } from "./canvas-boards-store"

vi.mock("@/lib/api", () => ({
  canvasListBoards: vi.fn(),
}))

const mockList = vi.mocked(canvasListBoards)

function board(id: number, over: Partial<CanvasBoard> = {}): CanvasBoard {
  return {
    id,
    name: `Board ${id}`,
    description: null,
    color: null,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    ...over,
  }
}

function summary(
  b: CanvasBoard,
  over: Partial<CanvasBoardSummary> = {}
): CanvasBoardSummary {
  return { board: b, node_count: 0, terminal_count: 0, preview: [], ...over }
}

const store = () => useCanvasBoardsStore.getState()
const ids = () => store().boards.map((s) => s.board.id)

/** A list read the test answers by hand, to interleave events with it. */
function deferredList() {
  let resolve: (list: CanvasBoardSummary[]) => void = () => {}
  mockList.mockImplementationOnce(() => new Promise((r) => (resolve = r)))
  return (list: CanvasBoardSummary[]) => resolve(list)
}

beforeEach(() => {
  store().reset()
  mockList.mockReset()
  mockList.mockResolvedValue([])
})

describe("canvas boards store", () => {
  it("a list read replaces the rows and marks the list loaded", async () => {
    mockList.mockResolvedValueOnce([
      summary(board(2), { node_count: 4 }),
      summary(board(1)),
    ])
    await store().refetch()
    expect(store().hydrated).toBe(true)
    expect(ids()).toEqual([2, 1])
    expect(store().boards[0].node_count).toBe(4)
  })

  it("a board created while a list read is out survives the read's answer", async () => {
    const answer = deferredList()
    const read = store().refetch()
    // The read was taken before this board existed…
    store().handleBoardChanged({ kind: "upsert", board: board(9) })
    answer([summary(board(1))])
    await read
    // …so applying its answer as-is would make the new board vanish.
    expect(ids()).toContain(9)
    expect(ids()).toContain(1)
  })

  it("a board deleted while a list read is out stays deleted", async () => {
    mockList.mockResolvedValueOnce([summary(board(1)), summary(board(2))])
    await store().refetch()
    const answer = deferredList()
    const read = store().refetch()
    store().handleBoardChanged({ kind: "deleted", id: 2 })
    answer([summary(board(1)), summary(board(2))])
    await read
    expect(ids()).toEqual([1])
  })

  it("a board edit keeps the counts and thumbnail it already had", async () => {
    mockList.mockResolvedValueOnce([
      summary(board(1), { node_count: 7, terminal_count: 1 }),
    ])
    await store().refetch()
    store().handleBoardChanged({
      kind: "upsert",
      board: board(1, { name: "Renamed", updated_at: "2026-09-02T00:00:00Z" }),
    })
    expect(store().boards[0].board.name).toBe("Renamed")
    expect(store().boards[0].node_count).toBe(7)
  })

  it("orders by last edit, newest first", async () => {
    mockList.mockResolvedValueOnce([
      summary(board(2, { updated_at: "2026-09-03T00:00:00Z" })),
      summary(board(1, { updated_at: "2026-09-02T00:00:00Z" })),
    ])
    await store().refetch()
    store().handleBoardChanged({
      kind: "upsert",
      board: board(1, { updated_at: "2026-09-04T00:00:00Z" }),
    })
    expect(ids()).toEqual([1, 2])
  })

  it("a late create answer cannot bring back a board deleted meanwhile", () => {
    const scope = store().scope()
    // Created, then deleted by another window before our answer arrived.
    store().handleBoardChanged({ kind: "upsert", board: board(5) })
    store().handleBoardChanged({ kind: "deleted", id: 5 })
    store().applyCreatedBoard(board(5), scope)
    expect(ids()).toEqual([])
  })

  it("a create answer adds the board, but never over a newer row", () => {
    const scope = store().scope()
    expect(
      store().applyCreatedBoard(board(6, { name: "created" }), scope)
    ).toBe(true)
    expect(ids()).toEqual([6])
    // Its event (and a rename after it) can also beat the answer home.
    store().handleBoardChanged({
      kind: "upsert",
      board: board(7, { name: "renamed" }),
    })
    store().applyCreatedBoard(board(7, { name: "created" }), scope)
    expect(store().boards.find((s) => s.board.id === 7)?.board.name).toBe(
      "renamed"
    )
  })

  it("a create answer replayed onto a newer list read does not overwrite it", async () => {
    const scope = store().scope()
    const answer = deferredList()
    const read = store().refetch()
    store().applyCreatedBoard(board(8, { name: "created" }), scope)
    // The read landed after a rename it alone knows about (its event was lost
    // while the transport was down).
    answer([summary(board(8, { name: "renamed" }), { node_count: 1 })])
    await read
    expect(store().boards).toHaveLength(1)
    expect(store().boards[0].board.name).toBe("renamed")
    expect(store().boards[0].node_count).toBe(1)
  })

  it("answers from before a backend switch are ignored", () => {
    const before = store().scope()
    store().reset()
    // The new backend happens to have a board with the same id.
    store().handleBoardChanged({ kind: "upsert", board: board(4) })
    expect(store().removeBoard(4, before)).toBe(false)
    expect(ids()).toEqual([4])
    expect(store().applyCreatedBoard(board(9), before)).toBe(false)
    expect(ids()).toEqual([4])
    // …while the current scope's own answers apply.
    expect(store().removeBoard(4, store().scope())).toBe(true)
    expect(ids()).toEqual([])
  })

  it("a list read cannot bring back a board whose deletion was seen", async () => {
    store().handleBoardChanged({ kind: "deleted", id: 3 })
    mockList.mockResolvedValueOnce([summary(board(3)), summary(board(4))])
    await store().refetch()
    expect(ids()).toEqual([4])
  })

  it("events apply in arrival order even against the clock", async () => {
    // Commit order is broadcast order; a server clock stepping back must not
    // pin a stale row, so events are not timestamp-guarded.
    mockList.mockResolvedValueOnce([
      summary(board(1, { updated_at: "2026-09-05T00:00:00Z" })),
    ])
    await store().refetch()
    store().handleBoardChanged({
      kind: "upsert",
      board: board(1, { name: "later", updated_at: "2026-09-04T00:00:00Z" }),
    })
    expect(store().boards[0].board.name).toBe("later")
  })

  it("a board deleted elsewhere while open is left, with a notice", () => {
    store().openBoard(3)
    store().handleBoardChanged({ kind: "deleted", id: 3 })
    expect(store().activeBoardId).toBeNull()
    expect(store().closedNotice).toBe(3)
    store().acknowledgeClosedNotice()
    expect(store().closedNotice).toBeNull()
  })

  it("only the open board is closed as missing", () => {
    store().openBoard(3)
    store().closeMissingBoard(4)
    expect(store().activeBoardId).toBe(3)
    expect(store().closedNotice).toBeNull()
  })

  it("a read requested mid-flight runs once more afterwards", async () => {
    const answer = deferredList()
    const first = store().refetch()
    const second = store().refetch()
    const third = store().refetch()
    mockList.mockResolvedValueOnce([summary(board(5))])
    answer([summary(board(1))])
    await first
    await second
    await third
    await vi.waitFor(() => expect(ids()).toEqual([5]))
    // Two requests while one was out collapse into ONE follow-up.
    expect(mockList).toHaveBeenCalledTimes(2)
  })

  it("keeps what it had when a read fails", async () => {
    mockList.mockResolvedValueOnce([summary(board(1))])
    await store().refetch()
    mockList.mockRejectedValueOnce(new Error("offline"))
    await store().refetch()
    expect(ids()).toEqual([1])
    expect(store().loadError).toBe("offline")
    await store().refetch()
    expect(store().loadError).toBeNull()
  })

  it("reset forgets the open board and strands a read in flight", async () => {
    store().openBoard(2)
    const answer = deferredList()
    const read = store().refetch()
    store().reset()
    answer([summary(board(1))])
    await read
    expect(store().activeBoardId).toBeNull()
    expect(store().hydrated).toBe(false)
    expect(ids()).toEqual([])
  })
})
