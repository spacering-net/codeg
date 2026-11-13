import { describe, expect, it, vi } from "vitest"
import {
  createFrontendMemoryTracker,
  type FrontendMemorySample,
} from "./frontend-memory"

describe("frontend memory diagnostics collector", () => {
  it("keeps numeric snapshots separate from provider lifetimes", () => {
    let now = 0
    const send = vi.fn(async () => {})
    const tracker = createFrontendMemoryTracker({
      reporterId: "12345678-1234-4234-8234-123456789abc",
      now: () => now,
      send,
    })
    const tracked = {}
    const read = vi.fn(() => ({
      connections: 2,
      liveTextUnits: 17,
    }))
    const unregister = tracker.registerProvider(tracked, read)
    const releaseSurface = tracker.registerSurface()

    expect(tracker.sample()).toMatchObject({
      reporterId: "12345678-1234-4234-8234-123456789abc",
      metrics: {
        providersActive: 1,
        providersMounted: 1,
        surfacesActive: 1,
        surfacesMounted: 1,
        connections: 2,
        liveTextUnits: 17,
      },
    })
    expect(read).toHaveBeenCalledTimes(1)

    unregister()
    releaseSurface()
    now = 1
    const afterRelease = tracker.sample()
    expect(afterRelease.metrics).toMatchObject({
      providersActive: 0,
      providersMounted: 1,
      providersUnmounted: 1,
      surfacesActive: 0,
      surfacesMounted: 1,
      surfacesUnmounted: 1,
      retiredStoresTracked: 1,
    })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it("serializes at most one send and drops invalid provider counters", async () => {
    let resolveSend: (() => void) | undefined
    const sent: FrontendMemorySample[] = []
    const send = vi.fn(
      async (sample: FrontendMemorySample) =>
        await new Promise<void>((resolve) => {
          sent.push(sample)
          resolveSend = resolve
        })
    )
    const tracker = createFrontendMemoryTracker({
      reporterId: "12345678-1234-4234-8234-123456789abc",
      send,
    })
    tracker.registerProvider(
      {},
      () =>
        ({
          connections: 3,
          // Unknown keys are impossible through the public type but can still
          // arrive from a defensive boundary at runtime.
          privateText: "secret",
          liveTextUnits: -1,
        }) as never
    )

    const first = tracker.flush()
    const second = tracker.flush()
    await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(1)
    expect(sent[0]?.metrics).toMatchObject({ connections: 3 })
    expect(sent[0]?.metrics).not.toHaveProperty("privateText")
    expect(sent[0]?.metrics).not.toHaveProperty("liveTextUnits")

    resolveSend?.()
    await Promise.all([first, second])
  })
})
