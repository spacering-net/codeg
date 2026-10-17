/**
 * Opening a conversation must never look like nothing is happening.
 *
 * Two legs precede a usable session, and BOTH used to report `status === null`
 * to the UI:
 *
 *   1. `preparing` — the panel holds auto-connect back until it has resolved
 *      the historical conversation's `external_id` (connecting without it makes
 *      the backend take `session/new` and orphan the history).
 *   2. `connecting` — `connect()` is in flight. The store gets no entry until
 *      the backend call returns, and that call spans agent spawn + `initialize`
 *      + `session/resume`, i.e. the slow part.
 *
 * These pin what each leg reports: a status-bar task row, and selector loading
 * so the composer can show placeholders instead of an empty control row.
 */

import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

vi.mock("@/contexts/acp-connections-context", () => ({
  useAcpActions: () => ({ setActiveKey: vi.fn(), touchActivity: vi.fn() }),
}))

const tasks = vi.hoisted(() => ({
  added: [] as { id: string; label: string; description?: string }[],
  updated: [] as { id: string; status?: string }[],
  removed: [] as string[],
  reset() {
    tasks.added = []
    tasks.updated = []
    tasks.removed = []
  },
  /** Rows currently on the status bar: added, never retired. */
  live() {
    const settled = new Set([
      ...tasks.removed,
      ...tasks.updated
        .filter((u) => u.status === "completed" || u.status === "failed")
        .map((u) => u.id),
    ])
    return tasks.added.filter((t) => !settled.has(t.id))
  },
}))

vi.mock("@/contexts/task-context", () => {
  // One identity for the hook's whole life, like the real provider's
  // `useCallback`s. A fresh `removeTask` per render re-runs the hook's
  // unmount cleanup on every rerender, which retires the very row under test.
  const context = {
    addTask: (id: string, label: string, description?: string) =>
      tasks.added.push({ id, label, description }),
    updateTask: (id: string, update: { status?: string }) =>
      tasks.updated.push({ id, ...update }),
    removeTask: (id: string) => tasks.removed.push(id),
  }
  return { useTaskContext: () => context }
})

const conn = vi.hoisted(() => ({
  status: null as string | null,
  /** The agent of the store entry at this key; null while there is none. */
  agentType: null as string | null,
  selectorsReady: false,
  hasCachedSelectors: false,
}))

vi.mock("@/hooks/use-connection", () => ({
  useConnection: () => ({
    status: conn.status,
    agentType: conn.agentType,
    selectorsReady: conn.selectorsReady,
    hasCachedSelectors: conn.hasCachedSelectors,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    sendPrompt: vi.fn().mockResolvedValue(undefined),
    setMode: vi.fn().mockResolvedValue(undefined),
    setConfigOption: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    respondPermission: vi.fn().mockResolvedValue(undefined),
    modes: null,
    configOptions: null,
    isViewer: false,
    backgroundOutstanding: 0,
  }),
}))

import { useConnectionLifecycle } from "@/hooks/use-connection-lifecycle"
import type { AgentType } from "@/lib/types"

function renderLifecycle(preparing: boolean) {
  return renderHook(
    (props: { preparing: boolean }) =>
      useConnectionLifecycle({
        contextKey: "ctx-1",
        agentType: "claude_code",
        // Mirrors the panel: the auto-connect gate is CLOSED while preparing.
        isActive: !props.preparing,
        preparing: props.preparing,
      }),
    { initialProps: { preparing } }
  )
}

describe("useConnectionLifecycle opening legs", () => {
  beforeEach(() => {
    tasks.reset()
    conn.status = null
    conn.agentType = null
    conn.selectorsReady = false
    conn.hasCachedSelectors = false
  })

  it("reports the historical-session wait as a status-bar task and as loading selectors", () => {
    const { result } = renderLifecycle(true)

    expect(tasks.live().map((t) => t.label)).toEqual([
      'tasks.preparingTitle:{"agent":"Claude Code"}',
    ])
    expect(result.current.modeLoading).toBe(true)
    expect(result.current.configOptionsLoading).toBe(true)
  })

  it("hands the row over from `preparing` to `connecting` rather than keeping stale wording", () => {
    const { rerender } = renderLifecycle(true)
    const prepared = tasks.live()[0]
    expect(prepared.label).toContain("preparingTitle")

    // The detail landed, so the panel opens the gate and connect() publishes
    // its in-flight marker — which `useConnection` reports as `connecting`.
    conn.status = "connecting"
    act(() => rerender({ preparing: false }))

    expect(tasks.removed).toContain(prepared.id)
    expect(tasks.live().map((t) => t.label)).toEqual([
      'tasks.connectingTitle:{"agent":"Claude Code"}',
    ])
  })

  it("settles the connect row once the session is up, leaving the bar clean", () => {
    const { rerender } = renderLifecycle(true)
    conn.status = "connecting"
    act(() => rerender({ preparing: false }))
    expect(tasks.live()).toHaveLength(1)

    // `connected` + selectors_ready is the end of the whole establishment.
    conn.status = "connected"
    conn.selectorsReady = true
    act(() => rerender({ preparing: false }))

    expect(tasks.live()).toEqual([])
  })

  it("renames the connect row when a draft switches agents before it connects", () => {
    // A draft's agent picker stays usable while it connects, and the status
    // reads `connecting` straight through the switch: the old agent's entry,
    // then the new one's in-flight marker, then its entry. The row has to
    // follow the agent coming up rather than the status, or it goes on naming
    // the agent the user just left.
    conn.status = "connecting"
    conn.agentType = "claude_code"
    const { rerender } = renderHook(
      (props: { agentType: AgentType }) =>
        useConnectionLifecycle({
          contextKey: "ctx-1",
          agentType: props.agentType,
          isActive: false,
        }),
      { initialProps: { agentType: "claude_code" as AgentType } }
    )
    const first = tasks.live()[0]
    expect(first.label).toBe('tasks.connectingTitle:{"agent":"Claude Code"}')

    // Picked, but the old agent's entry is still the one coming up: the
    // switch has not torn it down yet (or Codex's preflight failed and left
    // it running). The row keeps naming what is actually connecting.
    act(() => rerender({ agentType: "codex" }))
    expect(tasks.live()).toEqual([first])

    // The old entry is gone; Codex's in-flight marker carries the status.
    conn.agentType = null
    act(() => rerender({ agentType: "codex" }))
    expect(tasks.removed).toContain(first.id)
    const second = tasks.live()[0]
    expect(tasks.live().map((t) => t.label)).toEqual([
      'tasks.connectingTitle:{"agent":"Codex"}',
    ])

    // Codex's own entry lands, still connecting: same agent, same row.
    conn.agentType = "codex"
    act(() => rerender({ agentType: "codex" }))
    expect(tasks.live()).toEqual([second])
  })

  it("adds nothing while idle — a settled, disconnected tab is not opening", () => {
    const { result } = renderLifecycle(false)
    expect(tasks.live()).toEqual([])
    expect(result.current.configOptionsLoading).toBe(false)
  })

  it("skips the loading state when the agent's selectors are already cached", () => {
    // Nothing to wait for: the cache already says what the chips should read,
    // so a placeholder there would flicker over values we can render.
    conn.hasCachedSelectors = true
    const { result } = renderLifecycle(true)
    expect(result.current.modeLoading).toBe(false)
    expect(result.current.configOptionsLoading).toBe(false)
    // The status-bar row is independent of the cache — the session itself is
    // still not up.
    expect(tasks.live()).toHaveLength(1)
  })
})
