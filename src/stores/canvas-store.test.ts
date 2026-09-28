import { beforeEach, describe, expect, it, vi } from "vitest"
import type { CanvasChange, CanvasNode, CanvasSnapshot } from "@/lib/types"
import { canvasListNodes } from "@/lib/api"
import {
  beginContentWrite,
  hasContentWriteInFlight,
  useCanvasStore,
} from "./canvas-store"

vi.mock("@/lib/api", () => ({
  canvasListNodes: vi.fn(),
}))

const mockList = vi.mocked(canvasListNodes)

function makeNode(id: number, over: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id,
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
    created_at: "2026-08-30T00:00:00Z",
    updated_at: "2026-08-30T00:00:00Z",
    ...over,
  }
}

function snapshot(revision: number, nodes: CanvasNode[]): CanvasSnapshot {
  return { revision, nodes }
}

function upsert(revision: number, node: CanvasNode): CanvasChange {
  return { kind: "upsert", node, revision }
}

const store = () => useCanvasStore.getState()

beforeEach(() => {
  useCanvasStore.getState().reset()
  mockList.mockReset()
  // Default: refetch resolves to an empty, revision-0 snapshot (individual
  // tests override). Never leave it unmocked — a gap test would reject.
  mockList.mockResolvedValue(snapshot(0, []))
})

describe("in-flight note text", () => {
  it("stays marked until the LAST write for that note lands", () => {
    // Edit, blur, edit again, blur: two saves for one note are in the air at
    // once. A plain set would have the first response clear the mark the second
    // still needs, and the delete confirmation would read the (still empty)
    // cached row and take the note without asking.
    const first = beginContentWrite(7)
    const second = beginContentWrite(7)
    first()
    expect(hasContentWriteInFlight(7)).toBe(true)
    second()
    expect(hasContentWriteInFlight(7)).toBe(false)
  })

  it("tracks notes independently and ignores a repeated end", () => {
    const end = beginContentWrite(1)
    expect(hasContentWriteInFlight(1)).toBe(true)
    expect(hasContentWriteInFlight(2)).toBe(false)
    end()
    // Must not drive the count negative and wedge the node "in flight".
    end()
    expect(hasContentWriteInFlight(1)).toBe(false)
    beginContentWrite(1)()
    expect(hasContentWriteInFlight(1)).toBe(false)
  })

  it("is cleared by reset — the ids mean nothing in the next scope", () => {
    beginContentWrite(9)
    useCanvasStore.getState().reset()
    expect(hasContentWriteInFlight(9)).toBe(false)
  })

  it("a write stranded by reset cannot clear the next scope's mark", () => {
    // Backend switch with a save still in the air. Node ids are per-scope, so
    // the new scope can hand id 9 to a different note — and the old request
    // landing must not un-mark it, or the delete confirmation goes back to
    // reading a row that has not caught up yet.
    const stranded = beginContentWrite(9)
    useCanvasStore.getState().reset()

    const live = beginContentWrite(9)
    stranded()
    expect(hasContentWriteInFlight(9)).toBe(true)

    live()
    expect(hasContentWriteInFlight(9)).toBe(false)
  })
})

describe("canvas-store revision protocol", () => {
  it("applies consecutive events and advances lastRevision", () => {
    store().acceptSnapshot(snapshot(0, []))
    store().handleCanvasChanged(upsert(1, makeNode(1)))
    store().handleCanvasChanged(upsert(2, makeNode(2)))
    expect(store().lastRevision).toBe(2)
    expect([...store().nodes.keys()]).toEqual([1, 2])
  })

  it("drops stale events (revision at or below lastRevision)", () => {
    store().acceptSnapshot(snapshot(5, [makeNode(1, { title: "current" })]))
    store().handleCanvasChanged(upsert(5, makeNode(1, { title: "stale" })))
    store().handleCanvasChanged(upsert(3, makeNode(1, { title: "older" })))
    expect(store().nodes.get(1)?.title).toBe("current")
    expect(store().lastRevision).toBe(5)
  })

  it("on a gap: does NOT apply the event and refetches the snapshot", async () => {
    store().acceptSnapshot(snapshot(1, [makeNode(1)]))
    mockList.mockResolvedValue(snapshot(9, [makeNode(1), makeNode(7)]))

    store().handleCanvasChanged(upsert(9, makeNode(7)))
    // The gapped event itself must not touch state.
    expect(store().lastRevision).toBe(1)
    await vi.waitFor(() => expect(store().lastRevision).toBe(9))
    expect([...store().nodes.keys()]).toEqual([1, 7])
  })

  it("rejects snapshots older than what was already applied", () => {
    store().acceptSnapshot(snapshot(7, [makeNode(1)]))
    store().acceptSnapshot(snapshot(3, []))
    expect(store().lastRevision).toBe(7)
    expect(store().nodes.size).toBe(1)
    expect(store().hydrated).toBe(true)
  })

  it("response-before-event: applies optimistically, the event then advances", () => {
    store().acceptSnapshot(snapshot(2, []))
    // Command response arrives first (its event still in flight).
    store().applyResponse(3, (nodes) =>
      nodes.set(10, makeNode(10, { title: "optimistic" }))
    )
    expect(store().nodes.get(10)?.title).toBe("optimistic")
    // A response never advances the revision — only the event stream does.
    expect(store().lastRevision).toBe(2)
    // The matching event lands: idempotent re-apply, revision advances.
    store().handleCanvasChanged(
      upsert(3, makeNode(10, { title: "optimistic" }))
    )
    expect(store().lastRevision).toBe(3)
    expect(store().nodes.get(10)?.title).toBe("optimistic")
  })

  it("event-before-response: the late response is dropped whole", () => {
    store().acceptSnapshot(snapshot(2, []))
    store().handleCanvasChanged(
      upsert(3, makeNode(10, { title: "from-event" }))
    )
    expect(store().lastRevision).toBe(3)
    // The response for that same mutation arrives after its event.
    store().applyResponse(3, (nodes) =>
      nodes.set(10, makeNode(10, { title: "late-response" }))
    )
    expect(store().nodes.get(10)?.title).toBe("from-event")
  })

  it("moved events update positions of known nodes and skip ghosts", () => {
    store().acceptSnapshot(snapshot(1, [makeNode(1)]))
    store().handleCanvasChanged({
      kind: "moved",
      moves: [
        { id: 1, x: 50, y: 60 },
        { id: 999, x: 1, y: 2 },
      ],
      revision: 2,
    })
    expect(store().nodes.get(1)).toMatchObject({ x: 50, y: 60 })
    expect(store().nodes.has(999)).toBe(false)
  })

  it("detached events scrub the source region and upsert the pin", () => {
    const region = makeNode(1, { kind: "custom", member_ids: [7, 8] })
    store().acceptSnapshot(snapshot(1, [region]))
    const pin = makeNode(2, { kind: "conversation", conversation_id: 7 })
    store().handleCanvasChanged({
      kind: "detached",
      removed_from: 1,
      node: pin,
      revision: 2,
    })
    expect(store().nodes.get(1)?.member_ids).toEqual([8])
    expect(store().nodes.get(2)?.conversation_id).toBe(7)
  })

  it("pruned events drop pins and replace scrubbed regions", () => {
    const region = makeNode(1, { kind: "custom", member_ids: [7] })
    const pin = makeNode(2, { kind: "conversation", conversation_id: 7 })
    store().acceptSnapshot(snapshot(1, [region, pin]))
    store().handleCanvasChanged({
      kind: "pruned",
      deleted_ids: [2],
      updated: [makeNode(1, { kind: "custom", member_ids: [] })],
      revision: 2,
    })
    expect(store().nodes.has(2)).toBe(false)
    expect(store().nodes.get(1)?.member_ids).toEqual([])
  })

  it("reset returns to the cold state", () => {
    store().acceptSnapshot(snapshot(4, [makeNode(1)]))
    store().reset()
    expect(store().nodes.size).toBe(0)
    expect(store().lastRevision).toBe(0)
    expect(store().hydrated).toBe(false)
  })

  it("refetches again when the snapshot predates a gapped event", async () => {
    store().acceptSnapshot(snapshot(1, [makeNode(1)]))
    // First refetch resolves to a snapshot READ BEFORE the gapped mutation
    // (revision 3 < the gap's 5); the store must notice and go again.
    mockList
      .mockResolvedValueOnce(snapshot(3, [makeNode(1), makeNode(2)]))
      .mockResolvedValueOnce(
        snapshot(5, [makeNode(1), makeNode(2), makeNode(3)])
      )
    store().handleCanvasChanged(upsert(5, makeNode(3)))
    await vi.waitFor(() => expect(store().lastRevision).toBe(5))
    expect(mockList).toHaveBeenCalledTimes(2)
    expect(store().nodes.size).toBe(3)
  })

  it("retries after a failed refetch so a quiet canvas still heals", async () => {
    vi.useFakeTimers()
    try {
      store().acceptSnapshot(snapshot(1, [makeNode(1)]))
      mockList
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce(snapshot(4, [makeNode(1), makeNode(4)]))
      store().handleCanvasChanged(upsert(4, makeNode(4)))
      // Let the failing fetch settle, then advance past the retry delay.
      await vi.advanceTimersByTimeAsync(0)
      expect(store().lastRevision).toBe(1)
      await vi.advanceTimersByTimeAsync(5000)
      expect(store().lastRevision).toBe(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it("reset strands pre-reset fetches: no dedup reuse, no cross-scope write", async () => {
    let resolveFirst: (s: CanvasSnapshot) => void = () => {}
    mockList.mockImplementationOnce(
      () => new Promise((resolve) => (resolveFirst = resolve))
    )
    const first = store().refetch()
    store().reset()
    // A refetch AFTER reset must not be deduped onto the pre-reset promise.
    mockList.mockResolvedValueOnce(snapshot(2, [makeNode(9)]))
    await store().refetch()
    expect(store().nodes.has(9)).toBe(true)
    // The old fetch settles LATE with a higher revision — the epoch guard
    // must strand it entirely (previous backend scope's data).
    resolveFirst(snapshot(99, [makeNode(1, { title: "old scope" })]))
    await first
    expect(store().lastRevision).toBe(2)
    expect(store().nodes.has(1)).toBe(false)
  })

  it("a grouped event drops the absorbed pins and inserts the region as one step", () => {
    const pinA = makeNode(1, { kind: "conversation", conversation_id: 100 })
    const pinB = makeNode(2, { kind: "conversation", conversation_id: 200 })
    store().acceptSnapshot(snapshot(4, [pinA, pinB, makeNode(3)]))

    const region = makeNode(9, { kind: "custom", member_ids: [100, 200] })
    store().handleCanvasChanged({
      kind: "grouped",
      node: region,
      deleted_ids: [1, 2],
      revision: 5,
    })

    expect(store().lastRevision).toBe(5)
    expect([...store().nodes.keys()]).toEqual([3, 9])
    expect(store().nodes.get(9)?.member_ids).toEqual([100, 200])
  })

  it("re-applying a grouped payload is idempotent", () => {
    const region = makeNode(9, { kind: "custom", member_ids: [100] })
    store().acceptSnapshot(snapshot(4, [makeNode(1)]))
    const change: CanvasChange = {
      kind: "grouped",
      node: region,
      deleted_ids: [1],
      revision: 5,
    }
    store().handleCanvasChanged(change)
    // Same revision again: dropped as stale, and state is unchanged either way.
    store().handleCanvasChanged(change)
    expect([...store().nodes.keys()]).toEqual([9])
    expect(store().lastRevision).toBe(5)
  })
})
