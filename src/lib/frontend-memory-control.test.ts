import { describe, expect, it, vi } from "vitest"
import {
  createFrontendMemoryController,
  MEMORY_CONTROL_EVENT,
  type FrontendMemoryControl,
} from "./frontend-memory-control"
import type { Transport } from "./transport/types"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const mode = (epoch = 0, changes = {}): FrontendMemoryControl => ({
  epoch,
  reportingEnabled: true,
  browserCountersEnabled: true,
  sampleSequence: 0,
  ...changes,
})

async function settle() {
  for (let i = 0; i < 25; i++) await Promise.resolve()
}

function harness() {
  let receive: (value: unknown) => void = () => {}
  const initial = deferred<unknown>()
  const release = vi.fn()
  const call = vi.fn(async (command: string) => {
    if (command === "get_frontend_memory_control") return initial.promise
    return undefined
  })
  const subscribe = vi.fn(async (_event: string, handler: typeof receive) => {
    receive = handler
    return release
  })
  const flush = vi.fn(async () => true)
  const idle = vi.fn(async () => {})
  const setBrowserCountersEnabled = vi.fn()
  const active = vi.fn(() => true)
  const controller = createFrontendMemoryController({
    reporterId: "12345678-1234-4234-8234-123456789abc",
    transport: { call, subscribe } as unknown as Transport,
    flush,
    idle,
    setBrowserCountersEnabled,
    active,
    now: () => 1234,
  })
  const acknowledgements = () =>
    (call.mock.calls as unknown as [string, { ack?: object }][])
      .filter(([name]) => name === "ack_frontend_memory_control")
      .map(([, args]) => args.ack)
  return {
    controller,
    initial,
    release,
    call,
    subscribe,
    flush,
    idle,
    setBrowserCountersEnabled,
    active,
    acknowledgements,
    event: (value: unknown) => receive(value),
  }
}

describe("acknowledged frontend memory controls", () => {
  it("subscribes before reading and rejects a stale initial snapshot", async () => {
    const h = harness()
    expect(h.subscribe).toHaveBeenCalledWith(
      MEMORY_CONTROL_EVENT,
      expect.any(Function)
    )
    expect(h.call).not.toHaveBeenCalled()
    await settle()
    h.event(mode(2, { reportingEnabled: false }))
    h.initial.resolve(mode(1))
    await h.controller.ready
    expect(h.acknowledgements()).toEqual([
      expect.objectContaining({ epoch: 2, reportingEnabled: false }),
    ])
    expect(await h.controller.tick()).toBe(false)
    expect(h.flush).not.toHaveBeenCalled()
    h.controller.dispose()
    expect(h.release).toHaveBeenCalledTimes(1)
  })

  it("runs each explicit boundary once while periodic reporting stays paused", async () => {
    const h = harness()
    h.initial.resolve(mode(1, { reportingEnabled: false }))
    await h.controller.ready
    h.event(
      mode(2, {
        reportingEnabled: false,
        browserCountersEnabled: false,
        sampleSequence: 1,
      })
    )
    await settle()
    expect(h.flush).toHaveBeenCalledTimes(1)
    expect(h.acknowledgements().slice(-1)[0]).toMatchObject({
      epoch: 2,
      sampledEpoch: 2,
      sampleSequence: 1,
      sampleStartedAtMs: 1234,
    })
    h.event(mode(2, { sampleSequence: 1 }))
    expect(await h.controller.tick()).toBe(false)
    expect(h.flush).toHaveBeenCalledTimes(1)
    h.event(mode(3, { browserCountersEnabled: false, sampleSequence: 1 }))
    await settle()
    expect(await h.controller.tick()).toBe(true)
    expect(h.flush).toHaveBeenCalledTimes(2)
    expect(h.setBrowserCountersEnabled).toHaveBeenLastCalledWith(false)
    h.controller.dispose()
  })

  it("drains an existing send before acknowledging pause and coalesces newer modes", async () => {
    const h = harness()
    h.initial.resolve(mode())
    await h.controller.ready
    const pending = deferred<void>()
    h.idle.mockImplementation(() => pending.promise)
    h.event(mode(1, { reportingEnabled: false }))
    h.event(mode(2, { reportingEnabled: false, browserCountersEnabled: false }))
    expect(await h.controller.tick()).toBe(false)
    expect(h.acknowledgements()).toHaveLength(1)
    pending.resolve()
    await settle()
    expect(h.acknowledgements()).toHaveLength(2)
    expect(h.acknowledgements().slice(-1)[0]).toMatchObject({
      epoch: 2,
      reportingEnabled: false,
    })
    h.controller.dispose()
  })

  it("preserves the actual sample epoch when a mode changes during its send", async () => {
    const h = harness()
    h.initial.resolve(mode())
    await h.controller.ready
    const pending = deferred<boolean>()
    h.flush.mockImplementation(() => pending.promise)
    h.event(mode(1, { reportingEnabled: false, sampleSequence: 1 }))
    await settle()
    h.event(
      mode(2, {
        reportingEnabled: false,
        browserCountersEnabled: false,
        sampleSequence: 1,
      })
    )
    pending.resolve(true)
    await settle()
    expect(h.flush).toHaveBeenCalledTimes(1)
    expect(h.acknowledgements().slice(-1)[0]).toMatchObject({
      epoch: 2,
      sampledEpoch: 1,
      sampleSequence: 1,
    })
    h.controller.dispose()
  })

  it("does not acknowledge a failed boundary sample or silently enable periodic work", async () => {
    const h = harness()
    h.flush.mockResolvedValue(false)
    h.initial.resolve(mode(1, { sampleSequence: 1 }))
    await h.controller.ready
    expect(h.acknowledgements()).toHaveLength(0)
    expect(await h.controller.tick()).toBe(false)
    expect(h.flush).toHaveBeenCalledTimes(1)
    h.controller.dispose()
  })

  it("releases a subscription that resolves after disposal", async () => {
    const registration = deferred<() => void>()
    const release = vi.fn()
    const call = vi.fn()
    const controller = createFrontendMemoryController({
      reporterId: "opaque",
      transport: {
        call,
        subscribe: () => registration.promise,
      } as unknown as Transport,
      flush: async () => true,
      idle: async () => {},
      setBrowserCountersEnabled: () => {},
      active: () => true,
    })
    controller.dispose()
    registration.resolve(release)
    await controller.ready
    expect(release).toHaveBeenCalledTimes(1)
    expect(call).not.toHaveBeenCalled()
  })

  it("ignores pending reads, in-flight completions and later events after page cleanup", async () => {
    const h = harness()
    const pending = deferred<void>()
    h.idle.mockImplementation(() => pending.promise)
    await settle()
    h.event(mode(1, { sampleSequence: 1 }))
    h.controller.dispose()
    pending.resolve()
    h.initial.resolve(mode(2))
    await h.controller.ready
    h.event(mode(3))
    await settle()
    expect(h.acknowledgements()).toHaveLength(0)
    expect(h.flush).not.toHaveBeenCalled()
    expect(h.release).toHaveBeenCalledTimes(1)
  })

  it("bounds a rejected initialization and ignores malformed control vocabulary", async () => {
    const h = harness()
    h.initial.reject(new Error("unavailable"))
    await h.controller.ready
    expect(h.release).toHaveBeenCalledTimes(1)
    expect(await h.controller.tick()).toBe(false)
    h.controller.dispose()
    const other = harness()
    other.initial.resolve(mode())
    await other.controller.ready
    for (const invalid of [
      null,
      mode(-1),
      mode(1, { sampleSequence: 2 }),
      mode(1, { reportingEnabled: "yes" }),
      mode(1.5),
    ])
      other.event(invalid)
    await settle()
    expect(other.acknowledgements()).toHaveLength(1)
    other.controller.dispose()
  })
})
