import type { ReactNode } from "react"
import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import {
  StaticConnectionStoreProvider,
  type ConnectionState,
  type ConnectionStoreApi,
} from "@/contexts/acp-connections-context"
import { useChildProgress } from "./use-child-progress"

function call(id: string, status: string, title: string) {
  return { type: "tool_call", info: { tool_call_id: id, status, title } }
}

/** A store holding one child connection whose message the test rewrites. */
function childStore() {
  let content: unknown[] = []
  const listeners = new Set<() => void>()
  const store: ConnectionStoreApi = {
    getConnection: (key) =>
      key === "child"
        ? ({ liveMessage: { content } } as unknown as ConnectionState)
        : undefined,
    getConnectPending: () => undefined,
    getConnectError: () => undefined,
    getActiveKey: () => null,
    subscribeKey: (_key, listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    subscribeActiveKey: () => () => {},
  }
  const set = (next: unknown[]) => {
    content = next
    for (const listener of listeners) listener()
  }
  const wrapper = ({ children }: { children: ReactNode }) => (
    <StaticConnectionStoreProvider store={store}>
      {children}
    </StaticConnectionStoreProvider>
  )
  return { set, wrapper }
}

describe("useChildProgress", () => {
  it("follows the child's tool calls and ignores everything else", () => {
    const { set, wrapper } = childStore()
    const { result } = renderHook(() => useChildProgress("child"), {
      wrapper,
    })
    expect(result.current).toBeNull()

    act(() => set([call("a", "in_progress", "pnpm test")]))
    const running = result.current
    expect(running).toEqual({ steps: 0, marks: [], lastStep: "pnpm test" })

    // Streamed text changes the message, not the tally: same object back.
    act(() =>
      set([call("a", "in_progress", "pnpm test"), { type: "text", text: "…" }])
    )
    expect(result.current).toBe(running)

    act(() => set([call("a", "failed", "pnpm test")]))
    expect(result.current).toEqual({
      steps: 1,
      marks: ["failed"],
      lastStep: "pnpm test",
    })
  })

  it("has nothing to say without a connection", () => {
    const { wrapper } = childStore()
    const { result } = renderHook(() => useChildProgress(null), { wrapper })
    expect(result.current).toBeNull()
  })
})
