import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { ConnectionStatus, LiveSessionSnapshot } from "@/lib/types"

vi.mock("@/lib/api", () => ({
  acpGetSessionSnapshot: vi.fn(),
}))

import { acpGetSessionSnapshot } from "@/lib/api"
import { useAdvertisedGoalActions } from "./use-goal-actions"

const mockedFetch = vi.mocked(acpGetSessionSnapshot)

function snapshotWith(
  goalActions: string[] | null | undefined
): LiveSessionSnapshot {
  return { goal_actions: goalActions } as unknown as LiveSessionSnapshot
}

/** A pending promise whose resolution the test controls. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  mockedFetch.mockReset()
})

describe("useAdvertisedGoalActions", () => {
  it("exposes NO controls until the snapshot resolves, then the advertised list", async () => {
    const gate = deferred<LiveSessionSnapshot>()
    mockedFetch.mockReturnValue(gate.promise)
    const { result } = renderHook(() => useAdvertisedGoalActions("c1"))
    // Fail-closed window: a claude card must never flash a Pause it would
    // reject — unknown vocabulary renders as none.
    expect(result.current).toEqual([])
    act(() => gate.resolve(snapshotWith(["set", "clear"])))
    await waitFor(() => expect(result.current).toEqual(["set", "clear"]))
  })

  it("maps a snapshot MISSING goal_actions to the legacy vocabulary", async () => {
    mockedFetch.mockResolvedValue(snapshotWith(undefined))
    const { result } = renderHook(() => useAdvertisedGoalActions("c1"))
    await waitFor(() => expect(result.current).toEqual(["pause", "clear"]))
  })

  it("does NOT latch a still-initializing (null) vocabulary as legacy", async () => {
    // The field is present and explicitly null: the handshake hasn't answered.
    // Latching the legacy pair here is the claude-Pause bug — the adapter
    // rejects `pause` with `goal action must be "set" or "clear"`.
    mockedFetch.mockResolvedValue(snapshotWith(null))
    const { result } = renderHook(() => useAdvertisedGoalActions("c1", null))
    await act(async () => {})
    expect(result.current).toEqual([])
  })

  it("re-reads once the connection reports itself live, and latches then", async () => {
    // First read races `initialize` (null); the status flip is the signal to
    // ask again — by then the advertised vocabulary is decided.
    mockedFetch
      .mockResolvedValueOnce(snapshotWith(null))
      .mockResolvedValue(snapshotWith(["set", "clear"]))
    const { result, rerender } = renderHook(
      ({ status }: { status: ConnectionStatus }) =>
        useAdvertisedGoalActions("c1", status),
      { initialProps: { status: "connecting" as ConnectionStatus } }
    )
    await act(async () => {})
    expect(result.current).toEqual([])
    rerender({ status: "connected" })
    await waitFor(() => expect(result.current).toEqual(["set", "clear"]))
  })

  it("stops re-reading once the vocabulary is known", async () => {
    // The vocabulary is fixed for the connection's lifetime, so the
    // connected↔prompting flip of every turn must not refetch.
    mockedFetch.mockResolvedValue(snapshotWith(["set", "clear"]))
    const { result, rerender } = renderHook(
      ({ status }: { status: ConnectionStatus }) =>
        useAdvertisedGoalActions("c1", status),
      { initialProps: { status: "connected" as ConnectionStatus } }
    )
    await waitFor(() => expect(result.current).toEqual(["set", "clear"]))
    const callsAfterFirstRead = mockedFetch.mock.calls.length
    rerender({ status: "prompting" })
    await act(async () => {})
    rerender({ status: "connected" })
    await act(async () => {})
    expect(mockedFetch.mock.calls.length).toBe(callsAfterFirstRead)
  })

  it("stays at NO controls when the snapshot fetch fails", async () => {
    mockedFetch.mockRejectedValue(new Error("gone"))
    const { result } = renderHook(() => useAdvertisedGoalActions("c1"))
    // Give the rejection a tick to (not) apply.
    await act(async () => {})
    expect(result.current).toEqual([])
  })

  it("retries a transient failure instead of hiding the controls for good", async () => {
    // Mounting onto an already-settled connection means no status change is
    // coming, so one failed read would otherwise cost this connection its
    // buttons for its whole life.
    vi.useFakeTimers()
    try {
      mockedFetch
        .mockRejectedValueOnce(new Error("hiccup"))
        .mockResolvedValue(snapshotWith(["set", "clear"]))
      const { result } = renderHook(() =>
        useAdvertisedGoalActions("c1", "connected")
      )
      await act(async () => {})
      expect(result.current).toEqual([])
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
      expect(result.current).toEqual(["set", "clear"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("gives up after a bounded number of retries", async () => {
    // A connection that never answers must not be polled forever.
    vi.useFakeTimers()
    try {
      mockedFetch.mockResolvedValue(snapshotWith(null))
      const { result } = renderHook(() =>
        useAdvertisedGoalActions("c1", "connected")
      )
      // Drive the retry chain (each hop is timer → state → effect → fetch)
      // until two consecutive advances add no read: that is the budget
      // exhausting, not the harness running out of flushes.
      let previous = -1
      for (
        let i = 0;
        i < 12 && previous !== mockedFetch.mock.calls.length;
        i++
      ) {
        previous = mockedFetch.mock.calls.length
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10_000)
        })
      }
      expect(mockedFetch.mock.calls.length).toBe(previous)
      // The first read plus MAX_RETRIES timer-driven ones.
      expect(previous).toBe(5)
      expect(result.current).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it("stays at NO controls for a nullish snapshot (connection already gone)", async () => {
    // Nothing was LEARNED — only an existing snapshot missing the field maps
    // to the legacy vocabulary; a null one must not resurrect Pause.
    mockedFetch.mockResolvedValue(null as unknown as LiveSessionSnapshot)
    const { result } = renderHook(() => useAdvertisedGoalActions("c1"))
    await act(async () => {})
    expect(result.current).toEqual([])
  })

  it("never leaks the previous connection's vocabulary across a switch", async () => {
    const second = deferred<LiveSessionSnapshot>()
    mockedFetch.mockImplementation((id: string) =>
      id === "c1"
        ? Promise.resolve(snapshotWith(["pause", "clear"]))
        : second.promise
    )
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useAdvertisedGoalActions(id),
      { initialProps: { id: "c1" as string | null } }
    )
    await waitFor(() => expect(result.current).toEqual(["pause", "clear"]))
    // Reconnect/re-spawn: new id — the old vocabulary must vanish
    // IMMEDIATELY, not linger until the new fetch lands.
    rerender({ id: "c2" })
    expect(result.current).toEqual([])
    act(() => second.resolve(snapshotWith(["set", "clear"])))
    await waitFor(() => expect(result.current).toEqual(["set", "clear"]))
    // And a null id (no live connection) exposes none.
    rerender({ id: null })
    expect(result.current).toEqual([])
  })

  it("drops a stale response that resolves after the connection switched", async () => {
    const slow = deferred<LiveSessionSnapshot>()
    mockedFetch.mockImplementation((id: string) =>
      id === "old"
        ? slow.promise
        : Promise.resolve(snapshotWith(["set", "clear"]))
    )
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useAdvertisedGoalActions(id),
      { initialProps: { id: "old" as string | null } }
    )
    rerender({ id: "new" })
    await waitFor(() => expect(result.current).toEqual(["set", "clear"]))
    // The old connection's late response must not overwrite the new one.
    act(() => slow.resolve(snapshotWith(["pause", "clear"])))
    await act(async () => {})
    expect(result.current).toEqual(["set", "clear"])
  })
})
