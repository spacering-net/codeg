import { act, render, waitFor } from "@testing-library/react"
import { useEffect, type ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  listeners: new Map<string, (payload: unknown) => void>(),
  reconnect: new Set<() => void>(),
}))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({
    call: mocks.call,
    subscribe: (event: string, handler: (payload: unknown) => void) => {
      mocks.listeners.set(event, handler)
      return Promise.resolve(() => mocks.listeners.delete(event))
    },
    onReconnect: (handler: () => void) => {
      mocks.reconnect.add(handler)
      return () => mocks.reconnect.delete(handler)
    },
  }),
}))

import {
  HarnessViewProvider,
  useHarnessView,
} from "@/contexts/harness-view-context"
import { HARNESS_UPDATES, normalizeHarnessUpdates } from "./updates"
import {
  HarnessUpdatesSync,
  useHarnessUpdatesCheckOnOpen,
} from "./use-harness-updates"

function answer(count: number, overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    checking: false,
    checked_at: new Date().toISOString(),
    attempted_at: new Date().toISOString(),
    error: null,
    items: Array.from({ length: count }, (_, n) => ({
      id: `item-${n}`,
      revision: 1,
      state: "update_available",
      update_available: true,
      latest: { revision: 2, version: "2.0.0" },
      ref: `acme/item-${n}`,
    })),
    count,
    ...overrides,
  }
}

function Probe() {
  return <p data-testid="count">{useHarnessView().updatesCount}</p>
}

function Opener() {
  useHarnessUpdatesCheckOnOpen()
  return null
}

function wrap(children: ReactNode) {
  return <HarnessViewProvider>{children}</HarnessViewProvider>
}

const calls = () => mocks.call.mock.calls.map((args) => args[0])

beforeEach(() => {
  mocks.call.mockReset()
  mocks.listeners.clear()
  mocks.reconnect.clear()
})

describe("the sidebar badge's count", () => {
  it("comes from the host's answer and follows its events", async () => {
    mocks.call.mockResolvedValueOnce(answer(2))
    const view = render(
      wrap(
        <>
          <HarnessUpdatesSync />
          <Probe />
        </>
      )
    )
    await waitFor(() => expect(view.getByTestId("count").textContent).toBe("2"))
    expect(calls()).toEqual(["harness_updates"])

    // a check changed something: read again
    mocks.call.mockResolvedValueOnce(answer(3))
    act(() =>
      mocks.listeners.get("harness://updates-changed")?.({
        count: 3,
        item_ids: ["item-2"],
      })
    )
    await waitFor(() => expect(view.getByTestId("count").textContent).toBe("3"))

    // an uninstall: read again, against what is installed now
    mocks.call.mockResolvedValueOnce(answer(1))
    act(() =>
      mocks.listeners.get("harness://installed-changed")?.({
        item_ids: ["item-1"],
        agents: [],
      })
    )
    await waitFor(() => expect(view.getByTestId("count").textContent).toBe("1"))

    // after the event stream reconnects
    mocks.call.mockResolvedValueOnce(answer(0))
    act(() => [...mocks.reconnect].forEach((handler) => handler()))
    await waitFor(() => expect(view.getByTestId("count").textContent).toBe("0"))
    expect(calls()).toEqual([
      "harness_updates",
      "harness_updates",
      "harness_updates",
      "harness_updates",
    ])
  })

  it("is nothing where the catalog is switched off, or the host cannot say", async () => {
    mocks.call.mockResolvedValueOnce({ enabled: false, items: [], count: 0 })
    const view = render(
      wrap(
        <>
          <HarnessUpdatesSync />
          <Probe />
        </>
      )
    )
    await waitFor(() => expect(mocks.call).toHaveBeenCalled())
    expect(view.getByTestId("count").textContent).toBe("0")
    view.unmount()

    mocks.call.mockRejectedValueOnce("unknown command harness_updates")
    const again = render(
      wrap(
        <>
          <HarnessUpdatesSync />
          <Probe />
        </>
      )
    )
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    expect(again.getByTestId("count").textContent).toBe("0")
  })
})

describe("a section opening", () => {
  function openWith(value: ReturnType<typeof answer> | null) {
    let slotsSeen: ReturnType<typeof useHarnessView>["slots"] | null = null
    function Seed() {
      const current = useHarnessView().slots
      useEffect(() => {
        slotsSeen = current
      })
      return null
    }
    const view = render(wrap(<Seed />))
    if (value) {
      act(() =>
        slotsSeen!.set(HARNESS_UPDATES, (prev) => ({
          ...prev,
          phase: "ready" as const,
          value: normalizeHarnessUpdates(value),
        }))
      )
    }
    view.rerender(
      wrap(
        <>
          <Seed />
          <Opener />
        </>
      )
    )
    return { view, slots: () => slotsSeen! }
  }

  it("asks the host to check when its last answer is over an hour old", async () => {
    const old = new Date(Date.now() - 61 * 60 * 1000).toISOString()
    mocks.call.mockResolvedValue(answer(0))
    openWith(answer(1, { checked_at: old }))
    await waitFor(() =>
      expect(mocks.call).toHaveBeenCalledWith("harness_check_updates", {
        explicit: false,
      })
    )
    expect(mocks.call).toHaveBeenCalledTimes(1)
  })

  it("asks nothing when the last answer is recent", async () => {
    openWith(answer(1))
    await new Promise((done) => setTimeout(done, 10))
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it("waits for the host's answer before deciding, then asks once", async () => {
    mocks.call.mockResolvedValue(answer(0))
    const { slots, view } = openWith(null)
    expect(mocks.call).not.toHaveBeenCalled()
    act(() =>
      slots().set(HARNESS_UPDATES, (prev) => ({
        ...prev,
        phase: "ready" as const,
        value: normalizeHarnessUpdates(answer(1, { checked_at: null })),
      }))
    )
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
    // a later answer in the same visit does not ask again
    act(() =>
      slots().set(HARNESS_UPDATES, (prev) => ({
        ...prev,
        value: normalizeHarnessUpdates(answer(2, { checked_at: null })),
      }))
    )
    await new Promise((done) => setTimeout(done, 10))
    expect(mocks.call).toHaveBeenCalledTimes(1)
    view.unmount()
  })
})
