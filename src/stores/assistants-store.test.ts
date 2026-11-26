import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AssistantChange, AssistantInfo } from "@/lib/types"

const api = vi.hoisted(() => ({
  assistantList: vi.fn(),
}))
vi.mock("@/lib/api", () => api)

/** `subscribe` resolves when the test says the subscription is live. */
const platform = vi.hoisted(() => ({
  handler: null as ((change: AssistantChange) => void) | null,
  live: null as (() => void) | null,
  unsubscribed: 0,
}))
vi.mock("@/lib/platform", () => ({
  subscribe: (_event: string, handler: (change: AssistantChange) => void) => {
    platform.handler = handler
    return new Promise<() => void>((resolve) => {
      platform.live = () =>
        resolve(() => {
          platform.unsubscribed += 1
        })
    })
  },
  onTransportReconnect: () => () => {},
}))

import {
  mergeAssistantRows,
  orderedLiveAssistants,
  resetAssistantsStore,
  useAssistantsStore,
  useAssistantsSync,
} from "./assistants-store"

function row(
  id: number,
  revision: number,
  patch: Partial<AssistantInfo> = {}
): AssistantInfo {
  return {
    id,
    uid: `u-${id}`,
    name: `Assistant ${id}`,
    description: "",
    avatar: { kind: "monogram", color: "teal" },
    agent_type: "codex",
    agent_options: { config_values: {} },
    label_snapshot: { agent: "Codex CLI", mode: null, options: [] },
    instructions: "",
    enabled: true,
    sort_order: id,
    revision,
    created_at: "2026-10-16T00:00:00Z",
    updated_at: "2026-10-16T00:00:00Z",
    deleted_at: null,
    ...patch,
  }
}

const state = () => useAssistantsStore.getState()

describe("assistants store", () => {
  beforeEach(() => {
    resetAssistantsStore()
    for (const fn of Object.values(api)) fn.mockReset()
    platform.handler = null
    platform.live = null
    platform.unsubscribed = 0
  })
  afterEach(() => {
    resetAssistantsStore()
  })

  it("keeps whichever copy of a row has the higher revision", () => {
    state().merge([row(1, 3, { name: "New" })])
    // A late reply or an out-of-order broadcast of an older revision.
    state().merge([row(1, 2, { name: "Old" })])
    expect(state().byId.get(1)?.name).toBe("New")
    // An echo of the same revision changes nothing — not even the Map.
    const before = state().byId
    state().merge([row(1, 3, { name: "New" })])
    expect(state().byId).toBe(before)
    expect(mergeAssistantRows(before, [row(1, 3)])).toBeNull()
  })

  it("converges on a rename it missed while disconnected", async () => {
    state().merge([row(1, 1, { name: "Before" })])
    // Missed: the rename (r2). Received during the reconnect: a reorder that
    // moved the row (r3) — a WHOLE row, so it carries the new name too.
    state().applyChange({
      kind: "reordered",
      assistants: [row(1, 3, { name: "After", sort_order: 2 })],
    })
    // The reconnect's re-read is older than the reorder it raced.
    api.assistantList.mockResolvedValue([row(1, 2, { name: "After" })])
    await act(async () => {
      await state().fetchAll()
    })
    expect(state().byId.get(1)).toMatchObject({
      name: "After",
      revision: 3,
      sort_order: 2,
    })
  })

  it("keeps tombstones but leaves them out of the live list", () => {
    state().merge([
      row(1, 1),
      row(2, 2, { deleted_at: "2026-10-16T01:00:00Z" }),
    ])
    expect(state().byId.get(2)?.deleted_at).not.toBeNull()
    expect(orderedLiveAssistants(state().byId, null).map((a) => a.id)).toEqual([
      1,
    ])
  })

  it("re-reads the list on a resync nudge", async () => {
    api.assistantList.mockResolvedValue([row(5, 1)])
    await act(async () => {
      state().applyChange({ kind: "resync" })
      await Promise.resolve()
    })
    expect(api.assistantList).toHaveBeenCalledTimes(1)
    expect(state().byId.has(5)).toBe(true)
    expect(state().hydrated).toBe(true)
  })

  it("reads the list only once broadcasts reach the window", async () => {
    api.assistantList.mockResolvedValue([row(1, 1)])
    const { unmount } = renderHook(() => useAssistantsSync())
    await act(async () => {
      await Promise.resolve()
    })
    // A read now could miss a write that lands before the subscription.
    expect(api.assistantList).not.toHaveBeenCalled()
    // A broadcast already delivered while the server confirms the
    // subscription is merged all the same.
    act(() => platform.handler?.({ kind: "upsert", assistant: row(2, 1) }))
    expect(state().byId.has(2)).toBe(true)

    await act(async () => {
      platform.live?.()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(api.assistantList).toHaveBeenCalledTimes(1)
    expect(state().byId.has(1)).toBe(true)
    unmount()
    expect(platform.unsubscribed).toBe(1)
  })

  it("never reads after unmounting before the subscription went live", async () => {
    const { unmount } = renderHook(() => useAssistantsSync())
    unmount()
    await act(async () => {
      platform.live?.()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(api.assistantList).not.toHaveBeenCalled()
    expect(platform.unsubscribed).toBe(1)
  })
})
