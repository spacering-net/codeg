import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { TimelineRow } from "@/lib/types"

const api = vi.hoisted(() => ({
  personalAgentMarkSeen: vi.fn(),
}))
vi.mock("@/lib/api", () => api)

import { useOwnerSeen } from "./use-owner-seen"

const SEEN = "2026-11-04T10:05:00Z"

function row(
  id: number,
  kind: TimelineRow["kind"],
  patch: Partial<TimelineRow> = {}
): TimelineRow {
  return {
    id,
    segment_id: 1,
    batch_id: null,
    kind,
    status: null,
    body: "",
    data: null,
    dispatch_id: null,
    ref_id: null,
    reply_to: null,
    read_at: null,
    event_id: null,
    seen_at: null,
    created_at: "2026-11-04T10:00:00Z",
    updated_at: "2026-11-04T10:00:00Z",
    ...patch,
  }
}

const reply = (id: number, state: string, seen = false) =>
  row(id, "reply", { data: { state }, seen_at: seen ? SEEN : null })

interface Props {
  rows: TimelineRow[]
  watching: boolean
  unseenCount: number
}

function setup(initial: Props) {
  return renderHook((props: Props) => useOwnerSeen(props), {
    initialProps: initial,
  })
}

/** Let the mark's promise settle. */
async function flush() {
  for (let i = 0; i < 3; i++) await Promise.resolve()
}

beforeEach(() => {
  api.personalAgentMarkSeen.mockReset()
  api.personalAgentMarkSeen.mockResolvedValue(undefined)
})

describe("useOwnerSeen", () => {
  it("marks nothing while the owner does not watch", () => {
    const { result } = setup({
      rows: [row(1, "owner"), reply(2, "done")],
      watching: false,
      unseenCount: 1,
    })
    expect(api.personalAgentMarkSeen).not.toHaveBeenCalled()
    expect(result.current.newFrom).toBeNull()
  })

  it("marks up to the newest row once they watch, and keeps the first new message", () => {
    const rows = [
      reply(1, "done", true),
      row(2, "owner"),
      reply(3, "done"),
      row(4, "result"),
    ]
    const { result, rerender } = setup({
      rows,
      watching: false,
      unseenCount: 2,
    })
    rerender({ rows, watching: true, unseenCount: 2 })
    expect(api.personalAgentMarkSeen).toHaveBeenCalledTimes(1)
    expect(api.personalAgentMarkSeen).toHaveBeenCalledWith(4)
    expect(result.current.newFrom).toBe(3)

    // The marked rows come back seen: nothing left to mark, the line stays.
    const seen = [rows[0], rows[1], reply(3, "done", true), row(4, "result")]
    seen[3] = { ...seen[3], seen_at: SEEN }
    rerender({ rows: seen, watching: true, unseenCount: 0 })
    expect(api.personalAgentMarkSeen).toHaveBeenCalledTimes(1)
    expect(result.current.newFrom).toBe(3)
  })

  it("marks what lands while they watch, with no line for it", async () => {
    const rows = [row(1, "owner"), reply(2, "running")]
    const { result, rerender } = setup({
      rows,
      watching: true,
      unseenCount: 0,
    })
    expect(api.personalAgentMarkSeen).not.toHaveBeenCalled()
    // The running reply settles: new, and marked at once.
    rerender({
      rows: [row(1, "owner"), reply(2, "done")],
      watching: true,
      unseenCount: 0,
    })
    await flush()
    expect(api.personalAgentMarkSeen).toHaveBeenCalledWith(2)
    expect(result.current.newFrom).toBeNull()
  })

  it("puts the line at what came in while they were away", () => {
    const rows = [row(1, "owner"), reply(2, "done", true)]
    const { result, rerender } = setup({
      rows,
      watching: true,
      unseenCount: 0,
    })
    rerender({ rows, watching: false, unseenCount: 0 })
    const later = [...rows, row(3, "result"), reply(4, "done")]
    rerender({ rows: later, watching: false, unseenCount: 2 })
    expect(api.personalAgentMarkSeen).not.toHaveBeenCalled()
    rerender({ rows: later, watching: true, unseenCount: 2 })
    expect(result.current.newFrom).toBe(3)
    expect(api.personalAgentMarkSeen).toHaveBeenCalledWith(4)
    act(() => result.current.clearNewFrom())
    expect(result.current.newFrom).toBeNull()
  })

  it("marks what the server counts beyond the rows held", () => {
    setup({
      rows: [row(7, "owner"), reply(8, "done", true)],
      watching: true,
      unseenCount: 3,
    })
    expect(api.personalAgentMarkSeen).toHaveBeenCalledWith(8)
  })

  it("does not send the same mark twice, and tries again after a failure", async () => {
    api.personalAgentMarkSeen.mockRejectedValueOnce(new Error("offline"))
    const rows = [row(1, "owner"), reply(2, "done")]
    const { rerender } = setup({ rows, watching: true, unseenCount: 1 })
    expect(api.personalAgentMarkSeen).toHaveBeenCalledTimes(1)
    await flush()
    // Same state after the failure: a change brings the next try.
    rerender({ rows: [...rows], watching: true, unseenCount: 1 })
    expect(api.personalAgentMarkSeen).toHaveBeenCalledTimes(1)
    rerender({ rows, watching: true, unseenCount: 2 })
    expect(api.personalAgentMarkSeen).toHaveBeenCalledTimes(1)
    const more = [...rows, row(3, "result")]
    rerender({ rows: more, watching: true, unseenCount: 2 })
    expect(api.personalAgentMarkSeen).toHaveBeenCalledTimes(2)
    expect(api.personalAgentMarkSeen).toHaveBeenLastCalledWith(3)
  })
})
