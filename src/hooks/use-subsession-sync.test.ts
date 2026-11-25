import { renderHook, act } from "@testing-library/react"
import { useState, useRef } from "react"
import { describe, expect, it, vi, beforeEach } from "vitest"
import type { ConversationChange, DbConversationSummary } from "@/lib/types"

// Capture the event handler the hook registers + the reconnect callback, so the
// test can drive `conversation://changed` events through the real routing code.
let capturedHandler: ((c: ConversationChange) => void) | null = null
let reconnectCb: (() => void) | null = null
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(
    async (_event: string, handler: (c: ConversationChange) => void) => {
      capturedHandler = handler
      return () => {}
    }
  ),
  onTransportReconnect: vi.fn((cb: () => void) => {
    reconnectCb = cb
    return () => {}
  }),
}))

import { useSubsessionSync } from "./use-subsession-sync"

type ChildrenMap = Map<number, DbConversationSummary[]>

function child(
  id: number,
  parentId: number,
  overrides: Partial<DbConversationSummary> = {}
): DbConversationSummary {
  const created = new Date(1_700_000_000_000 + id * 1000).toISOString()
  return {
    id,
    folder_id: 1,
    title: `c-${id}`,
    title_locked: false,
    agent_type: "codex",
    status: "pending",
    kind: "delegate",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 0,
    child_count: 0,
    created_at: created,
    updated_at: created,
    pinned_at: null,
    parent_id: parentId,
    ...overrides,
  }
}

function useHarness(initial: ChildrenMap) {
  const [childrenByParent, setChildrenByParent] = useState(initial)
  const deletedChildIdsRef = useRef<Set<number>>(new Set())
  const rootIdsRef = useRef<Set<number>>(new Set())
  useSubsessionSync({ setChildrenByParent, deletedChildIdsRef, rootIdsRef })
  return childrenByParent
}

async function setup(initial: ChildrenMap) {
  const r = renderHook(() => useHarness(initial))
  // subscribe is async — flush the microtask that captures the handler.
  await act(async () => {})
  return r
}

describe("useSubsessionSync", () => {
  beforeEach(() => {
    capturedHandler = null
    reconnectCb = null
  })

  it("routes a child status event into its parent's array", async () => {
    const { result } = await setup(
      new Map([[1, [child(100, 1), child(101, 1)]]])
    )
    act(() =>
      capturedHandler!({ kind: "status", id: 100, status: "completed" })
    )
    const arr = result.current.get(1)!
    expect(arr[0].status).toBe("completed")
    expect(arr[1].status).toBe("pending") // sibling untouched
  })

  it("keeps sibling parent arrays referentially stable on a status event", async () => {
    const a = [child(100, 1)]
    const b = [child(200, 2)]
    const { result } = await setup(
      new Map([
        [1, a],
        [2, b],
      ])
    )
    act(() =>
      capturedHandler!({ kind: "status", id: 100, status: "completed" })
    )
    expect(result.current.get(2)).toBe(b) // untouched parent keeps identity
    expect(result.current.get(1)).not.toBe(a) // touched parent rebuilt
  })

  it("inserts a new child upsert in created_at DESC (newest-first) order", async () => {
    const { result } = await setup(
      new Map([[1, [child(102, 1), child(100, 1)]]])
    )
    act(() => capturedHandler!({ kind: "upsert", summary: child(101, 1) }))
    expect(result.current.get(1)!.map((c) => c.id)).toEqual([102, 101, 100])
  })

  it("replaces an existing child on upsert without duplicating", async () => {
    const { result } = await setup(new Map([[1, [child(100, 1)]]]))
    act(() =>
      capturedHandler!({
        kind: "upsert",
        summary: child(100, 1, { status: "completed" }),
      })
    )
    const arr = result.current.get(1)!
    expect(arr).toHaveLength(1)
    expect(arr[0].status).toBe("completed")
  })

  it("ignores a child upsert whose parent is not loaded (lazy invariant)", async () => {
    const { result } = await setup(new Map())
    act(() => capturedHandler!({ kind: "upsert", summary: child(100, 1) }))
    expect(result.current.size).toBe(0)
  })

  it("moves a child that became a root out of its parent's array", async () => {
    // An ask conversation converted into an ordinary one.
    const sibling = child(200, 2)
    const { result } = await setup(
      new Map([
        [1, [child(101, 1, { kind: "ask" }), child(100, 1)]],
        [2, [sibling]],
      ])
    )
    act(() =>
      capturedHandler!({
        kind: "upsert",
        summary: child(101, 1, { kind: "regular", parent_id: null }),
      })
    )
    expect(result.current.get(1)!.map((c) => c.id)).toEqual([100])
    expect(result.current.get(2)![0]).toBe(sibling)
    // A root never becomes a child again: a late upsert still showing it
    // nested is stale, and doesn't nest it back.
    act(() =>
      capturedHandler!({
        kind: "upsert",
        summary: child(101, 1, { kind: "ask" }),
      })
    )
    expect(result.current.get(1)!.map((c) => c.id)).toEqual([100])
  })

  it("leaves the subtree alone on a root upsert it never held", async () => {
    const initial = new Map([[1, [child(100, 1)]]])
    const { result } = await setup(initial)
    const before = result.current
    act(() =>
      capturedHandler!({
        kind: "upsert",
        summary: child(300, 1, { kind: "regular", parent_id: null }),
      })
    )
    expect(result.current).toBe(before)
  })

  it("removes a deleted child from its parent's array", async () => {
    const { result } = await setup(
      new Map([[1, [child(100, 1), child(101, 1)]]])
    )
    act(() => capturedHandler!({ kind: "deleted", id: 100 }))
    expect(result.current.get(1)!.map((c) => c.id)).toEqual([101])
  })

  it("drops the entire descendant subtree cache when a loaded parent is deleted", async () => {
    const { result } = await setup(
      new Map([
        [1, [child(100, 1)]],
        [100, [child(200, 100)]],
        [200, [child(300, 200)]],
      ])
    )
    act(() => capturedHandler!({ kind: "deleted", id: 100 }))
    expect(result.current.get(1)!.map((c) => c.id)).toEqual([]) // removed from parent
    expect(result.current.has(100)).toBe(false) // own cache dropped
    expect(result.current.has(200)).toBe(false) // grandchild subtree dropped
  })

  it("ignores a status event for an unknown (root or unloaded) id", async () => {
    const a = [child(100, 1)]
    const { result } = await setup(new Map([[1, a]]))
    act(() =>
      capturedHandler!({ kind: "status", id: 999, status: "completed" })
    )
    expect(result.current.get(1)).toBe(a) // no change, identity stable
  })

  it("does not resurrect a deleted child on a stale out-of-order upsert", async () => {
    const { result } = await setup(
      new Map([[1, [child(100, 1), child(101, 1)]]])
    )
    act(() => capturedHandler!({ kind: "deleted", id: 100 }))
    expect(result.current.get(1)!.map((c) => c.id)).toEqual([101])
    // A late upsert for the just-deleted child must NOT reinsert it.
    act(() => capturedHandler!({ kind: "upsert", summary: child(100, 1) }))
    expect(result.current.get(1)!.map((c) => c.id)).toEqual([101])
  })

  it("clears the cache on transport reconnect", async () => {
    const { result } = await setup(new Map([[1, [child(100, 1)]]]))
    expect(result.current.size).toBe(1)
    act(() => reconnectCb!())
    expect(result.current.size).toBe(0)
  })
})
