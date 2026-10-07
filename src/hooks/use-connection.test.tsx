import { act, renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { ConnectionState } from "@/contexts/acp-connections-context"

// Minimal fake connection store: one mutable connection + a listener set the
// hook subscribes to. `setConn` mutates and notifies (like a dispatch would).
const fake = vi.hoisted(() => {
  let conn: ConnectionState | undefined
  // The in-flight-connect() marker, which lives beside the connections map and
  // rides the same per-key listeners.
  let pending: { agentType: string; workingDir: string | null } | undefined
  const listeners = new Set<() => void>()
  return {
    reset() {
      conn = undefined
      pending = undefined
      listeners.clear()
    },
    setConn(next: ConnectionState | undefined) {
      conn = next
      for (const l of listeners) l()
    },
    setPending(next: { agentType: string; workingDir: string | null } | null) {
      pending = next ?? undefined
      for (const l of listeners) l()
    },
    store: {
      getConnection: () => conn,
      getConnectPending: () => pending,
      getActiveKey: () => null,
      subscribeKey: (_key: string, cb: () => void) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
      subscribeActiveKey: () => () => {},
    },
  }
})

vi.mock("@/contexts/acp-connections-context", () => {
  // A STABLE actions object (same reference every call) so useConnection's
  // callback memos keep a stable identity across renders. Without this the final
  // useMemo would churn on every render regardless of the snapshot, and a
  // render-count probe couldn't isolate the snapshot-skip behavior.
  const actions = {
    connect: () => {},
    disconnect: () => {},
    sendPrompt: () => {},
    setMode: () => {},
    setConfigOption: () => {},
    cancel: () => {},
    respondPermission: () => {},
    answerQuestion: () => {},
    reapplyConfig: () => {},
    dismissConfigStale: () => {},
  }
  return {
    useConnectionStore: () => fake.store,
    useAcpActions: () => actions,
    getCachedSelectors: () => null,
  }
})

import { connRenderEqual, useConnection } from "./use-connection"

// A consistent-shaped connection snapshot (same key set across calls, so the
// key-count fast path in connRenderEqual stays stable). Includes the two
// internal streaming fields (liveMessage, lastAppliedSeq) it must ignore.
function makeConn(over: Partial<ConnectionState>): ConnectionState {
  return {
    connectionId: "c1",
    contextKey: "k",
    agentType: "claude_code",
    status: "prompting",
    liveMessage: { id: "m1", role: "assistant", content: [], startedAt: 0 },
    lastAppliedSeq: 0,
    ...over,
  } as unknown as ConnectionState
}

describe("connRenderEqual", () => {
  it("treats snapshots that differ only in liveMessage as equal", () => {
    const a = makeConn({})
    const b = makeConn({ liveMessage: { ...a.liveMessage!, content: [] } })
    expect(a).not.toBe(b)
    expect(connRenderEqual(a, b)).toBe(true)
  })

  it("treats a lastAppliedSeq-only change (EVENT_APPLIED) as equal", () => {
    // Every accepted envelope bumps lastAppliedSeq via EVENT_APPLIED; it is
    // internal dedup state and must not re-render consumers.
    expect(connRenderEqual(makeConn({}), makeConn({ lastAppliedSeq: 7 }))).toBe(
      true
    )
  })

  it("treats a combined liveMessage + lastAppliedSeq change (real stream) as equal", () => {
    const a = makeConn({ lastAppliedSeq: 1 })
    const b = makeConn({
      liveMessage: { id: "m1", role: "assistant", content: [], startedAt: 0 },
      lastAppliedSeq: 2,
    })
    expect(connRenderEqual(a, b)).toBe(true)
  })

  it("detects a non-internal field change", () => {
    const a = makeConn({ status: "prompting" })
    const b = makeConn({ status: "connected" })
    expect(connRenderEqual(a, b)).toBe(false)
  })

  it("detects a differing key set (added/removed field)", () => {
    const a = makeConn({})
    const b = { ...makeConn({}), extra: 1 } as unknown as ConnectionState
    expect(connRenderEqual(a, b)).toBe(false)
  })

  it("handles reference identity and nulls", () => {
    const a = makeConn({})
    expect(connRenderEqual(a, a)).toBe(true)
    expect(connRenderEqual(a, null)).toBe(false)
    expect(connRenderEqual(null, null)).toBe(true)
  })
})

describe("useConnection snapshot stability", () => {
  // Directly count how many times a consumer of useConnection renders. Actions
  // are stably mocked (above), so a render happens iff useSyncExternalStore sees
  // a new snapshot — i.e. iff a render-relevant field changed.
  function renderProbe() {
    let renders = 0
    const { result } = renderHook(() => {
      renders++
      return useConnection("k")
    })
    return {
      get renders() {
        return renders
      },
      result,
    }
  }

  it("does NOT re-render on a real streaming token (liveMessage + lastAppliedSeq)", () => {
    fake.reset()
    fake.setConn(makeConn({ lastAppliedSeq: 1 }))
    const probe = renderProbe()
    const mounted = probe.renders
    const first = probe.result.current

    // A real streaming token mutates liveMessage AND advances lastAppliedSeq
    // (EVENT_APPLIED). Neither is rendered → NO additional render, stable return.
    act(() => {
      fake.setConn(
        makeConn({
          liveMessage: {
            id: "m1",
            role: "assistant",
            content: [{ type: "text", text: "hi" } as never],
            startedAt: 0,
          },
          lastAppliedSeq: 2,
        })
      )
    })
    expect(probe.renders).toBe(mounted) // zero extra renders
    expect(probe.result.current).toBe(first)
  })

  it("re-renders exactly once on a render-relevant change (status), even alongside streaming state", () => {
    fake.reset()
    fake.setConn(makeConn({ status: "prompting", lastAppliedSeq: 1 }))
    const probe = renderProbe()
    const mounted = probe.renders

    // Status flips (and lastAppliedSeq also advances, as it would live) → exactly
    // one re-render, and the new status is observed.
    act(() => {
      fake.setConn(makeConn({ status: "connected", lastAppliedSeq: 2 }))
    })
    expect(probe.renders).toBe(mounted + 1)
    expect(probe.result.current.status).toBe("connected")
  })
})

describe("useConnection in-flight connect", () => {
  it("reports `connecting` while a connect() is in flight with no entry yet", () => {
    fake.reset()
    const { result } = renderHook(() => useConnection("k"))
    // No entry, no in-flight connect — nothing is happening.
    expect(result.current.status).toBeNull()

    // `connect()` published its marker BEFORE the (slow) backend call that
    // eventually creates the entry. That whole stretch has to read as
    // connecting, or the composer and status bar see an idle session.
    act(() => fake.setPending({ agentType: "claude_code", workingDir: "/w" }))
    expect(result.current.status).toBe("connecting")

    // The entry lands: its own status is the more specific truth from here on,
    // including once the marker is cleared in connect()'s finally.
    act(() => fake.setConn(makeConn({ status: "connected" })))
    expect(result.current.status).toBe("connected")
    act(() => fake.setPending(null))
    expect(result.current.status).toBe("connected")
  })

  it("falls back to null once a failed connect clears its marker", () => {
    fake.reset()
    fake.setPending({ agentType: "codex", workingDir: null })
    const { result } = renderHook(() => useConnection("k"))
    expect(result.current.status).toBe("connecting")

    // A connect that threw (agent not installed, spawn failure) leaves no
    // entry behind, so the key goes back to reporting nothing in flight.
    act(() => fake.setPending(null))
    expect(result.current.status).toBeNull()
  })
})
