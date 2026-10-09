import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ConnectionState } from "@/contexts/acp-connections-context"

// Minimal fake connection store: connections by key, and per-key listeners the
// hook subscribes to. `set` replaces a key's connection and notifies that key,
// like a dispatch would.
const fake = vi.hoisted(() => {
  const connections = new Map<string, unknown>()
  const listeners = new Map<string, Set<() => void>>()
  return {
    reset() {
      connections.clear()
      listeners.clear()
    },
    set(key: string, conn: unknown) {
      connections.set(key, conn)
      for (const cb of listeners.get(key) ?? []) cb()
    },
    listenerCount(key: string) {
      return listeners.get(key)?.size ?? 0
    },
    store: {
      getConnection: (key: string) => connections.get(key),
      subscribeKey: (key: string, cb: () => void) => {
        const set = listeners.get(key) ?? new Set<() => void>()
        listeners.set(key, set)
        set.add(cb)
        return () => {
          set.delete(cb)
        }
      },
    },
  }
})

vi.mock("@/contexts/acp-connections-context", () => ({
  useConnectionStore: () => fake.store,
}))

import { useTabAttention } from "./use-tab-attention"

function conn(over: Partial<ConnectionState> = {}): ConnectionState {
  return {
    status: "prompting",
    liveMessage: null,
    pendingPermission: null,
    pendingQuestion: null,
    pendingAskQuestion: null,
    pendingPlanApproval: null,
    ...over,
  } as unknown as ConnectionState
}

const permission = { request_id: "r1", tool_call: null, options: [] }
const plan = {
  approval_id: "a1",
  tool_call_id: "c1",
  plan_markdown: "# Plan",
  created_at: "2026-01-01T00:00:00Z",
}

describe("useTabAttention", () => {
  beforeEach(() => fake.reset())

  it("maps each blocked tab to what it waits on", () => {
    fake.set("tab-a", conn({ pendingPermission: permission }))
    fake.set("tab-b", conn())
    // tab-c has no connection at all.
    const ids = ["tab-a", "tab-b", "tab-c"]
    const { result } = renderHook(() => useTabAttention(ids))
    expect([...result.current]).toEqual([["tab-a", "permission"]])
  })

  it("follows a prompt arriving and being answered", () => {
    fake.set("tab-a", conn())
    const ids = ["tab-a"]
    const { result } = renderHook(() => useTabAttention(ids))
    expect(result.current.size).toBe(0)

    act(() => fake.set("tab-a", conn({ pendingPlanApproval: plan })))
    expect(result.current.get("tab-a")).toBe("plan_approval")

    act(() => fake.set("tab-a", conn()))
    expect(result.current.size).toBe(0)
  })

  it("does not re-render while only streaming state changes", () => {
    fake.set("tab-a", conn({ pendingPermission: permission }))
    const ids = ["tab-a"]
    let renders = 0
    const { result } = renderHook(() => {
      renders++
      return useTabAttention(ids)
    })
    const first = result.current
    const rendersBefore = renders

    act(() =>
      fake.set(
        "tab-a",
        conn({
          pendingPermission: permission,
          liveMessage: {
            id: "m1",
            role: "assistant",
            content: [{ type: "text", text: "Working on it" }],
            startedAt: 0,
          },
        })
      )
    )
    expect(result.current).toBe(first)
    expect(renders).toBe(rendersBefore)
  })

  it("lets go of every key on unmount", () => {
    const ids = ["tab-a", "tab-b"]
    const { unmount } = renderHook(() => useTabAttention(ids))
    expect(fake.listenerCount("tab-a")).toBe(1)
    expect(fake.listenerCount("tab-b")).toBe(1)
    unmount()
    expect(fake.listenerCount("tab-a")).toBe(0)
    expect(fake.listenerCount("tab-b")).toBe(0)
  })
})
