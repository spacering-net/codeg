import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ConversationChange, DbConversationSummary } from "@/lib/types"

const h = vi.hoisted(() => ({
  list: vi.fn(),
  handler: null as ((event: ConversationChange) => void) | null,
  reconnect: new Set<() => void>(),
}))
vi.mock("@/lib/api", () => ({ listChildConversations: h.list }))
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(async (_name: string, handler: typeof h.handler) => {
    h.handler = handler
    return () => {}
  }),
  onTransportReconnect: (handler: () => void) => {
    h.reconnect.add(handler)
    return () => h.reconnect.delete(handler)
  },
}))

import { useConversationSubSessions } from "./use-conversation-sub-sessions"

function child(id: number, parentId = 1): DbConversationSummary {
  return {
    id,
    folder_id: 1,
    title: `task-${id}`,
    title_locked: false,
    agent_type: "codex",
    status: "completed",
    kind: "delegate",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 1,
    child_count: 0,
    created_at: new Date(1_700_000_000_000 + id * 1000).toISOString(),
    updated_at: "2026-10-14T00:00:00Z",
    pinned_at: null,
    parent_id: parentId,
  }
}

function deferred() {
  let resolve!: (children: DbConversationSummary[]) => void
  const promise = new Promise<DbConversationSummary[]>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("useConversationSubSessions", () => {
  beforeEach(() => {
    h.list.mockReset().mockResolvedValue([])
    h.handler = null
    h.reconnect.clear()
  })

  it("recovers historical children on a fresh mount without live delegation events", async () => {
    h.list.mockResolvedValue([child(1), child(2)])
    const first = renderHook(() => useConversationSubSessions(1))
    await waitFor(() => expect(first.result.current.loading).toBe(false))
    expect(first.result.current.children.map((c) => c.id)).toEqual([2, 1])
    first.unmount()
    const fresh = renderHook(() => useConversationSubSessions(1))
    await waitFor(() => expect(fresh.result.current.children).toHaveLength(2))
    expect(h.list).toHaveBeenCalledTimes(2)
  })

  it("keeps a child created while the history request was in flight", async () => {
    const request = deferred()
    h.list.mockReturnValue(request.promise)
    const { result } = renderHook(() => useConversationSubSessions(1))
    await waitFor(() => expect(h.handler).not.toBeNull())
    act(() => h.handler!({ kind: "upsert", summary: child(2) }))
    await act(async () => request.resolve([child(1)]))
    expect(result.current.children.map((c) => c.id)).toEqual([2, 1])
  })

  it("does not resurrect a child deleted before a stale history result arrives", async () => {
    const request = deferred()
    h.list.mockReturnValue(request.promise)
    const { result } = renderHook(() => useConversationSubSessions(1))
    await waitFor(() => expect(h.handler).not.toBeNull())
    act(() => h.handler!({ kind: "deleted", id: 1 }))
    await act(async () => request.resolve([child(1), child(2)]))
    act(() => h.handler!({ kind: "upsert", summary: child(1) }))
    expect(result.current.children.map((c) => c.id)).toEqual([2])
  })

  it("keeps an id-only completion event received before the child history arrives", async () => {
    const request = deferred()
    h.list.mockReturnValue(request.promise)
    const { result } = renderHook(() => useConversationSubSessions(1))
    await waitFor(() => expect(h.handler).not.toBeNull())
    act(() => h.handler!({ kind: "status", id: 1, status: "completed" }))
    await act(async () =>
      request.resolve([{ ...child(1), status: "in_progress" }])
    )
    expect(result.current.children[0].status).toBe("completed")
  })

  it("isolates parents when tab switching races a pending history request", async () => {
    const request = deferred()
    h.list
      .mockReturnValueOnce(request.promise)
      .mockResolvedValueOnce([child(3, 2), child(4, 99)])
    const { result, rerender } = renderHook(
      ({ parentId }) => useConversationSubSessions(parentId),
      { initialProps: { parentId: 1 } }
    )
    rerender({ parentId: 2 })
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => request.resolve([child(1)]))
    expect(result.current.children.map((c) => c.id)).toEqual([3])
  })

  it("discards pre-reconnect responses and refetches missed child changes", async () => {
    const before = deferred()
    const after = deferred()
    h.list
      .mockReturnValueOnce(before.promise)
      .mockReturnValueOnce(after.promise)
    const { result } = renderHook(() => useConversationSubSessions(1))
    await waitFor(() => expect(h.reconnect.size).toBe(2))
    act(() => h.reconnect.forEach((handler) => handler()))
    await waitFor(() => expect(h.list).toHaveBeenCalledTimes(2))
    await act(async () => before.resolve([child(1)]))
    expect(result.current.children).toEqual([])
    expect(result.current.loading).toBe(true)
    await act(async () => after.resolve([child(2)]))
    expect(result.current.children.map((c) => c.id)).toEqual([2])
  })

  it("reports a failed load and retries only when requested", async () => {
    h.list
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([child(1)])
    const { result } = renderHook(() => useConversationSubSessions(1))
    await waitFor(() => expect(result.current.error).toBe(true))
    expect(h.list).toHaveBeenCalledTimes(1)
    act(() => result.current.reload())
    await waitFor(() => expect(result.current.children).toHaveLength(1))
    expect(result.current.error).toBe(false)
  })
})
