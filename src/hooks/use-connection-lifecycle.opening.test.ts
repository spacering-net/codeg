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

vi.mock("@/contexts/task-context", () => ({
  useTaskContext: () => ({
    addTask: (id: string, label: string, description?: string) =>
      tasks.added.push({ id, label, description }),
    updateTask: (id: string, update: { status?: string }) =>
      tasks.updated.push({ id, ...update }),
    removeTask: (id: string) => tasks.removed.push(id),
  }),
}))

const conn = vi.hoisted(() => ({
  status: null as string | null,
  selectorsReady: false,
  hasCachedSelectors: false,
}))

vi.mock("@/hooks/use-connection", () => ({
  useConnection: () => ({
    status: conn.status,
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
