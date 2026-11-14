import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createFrontendMemoryTracker,
  type FrontendMemorySample,
} from "./frontend-memory"

afterEach(() => vi.unstubAllGlobals())

function controllableWeakRefs() {
  const cells: Array<{ target: object | undefined }> = []
  vi.stubGlobal(
    "WeakRef",
    class {
      private cell: { target: object | undefined }
      constructor(target: object) {
        this.cell = { target }
        cells.push(this.cell)
      }
      deref() {
        return this.cell.target
      }
    }
  )
  return cells
}

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

  it("observes retired runtime targets without serializing their contents", () => {
    const cells = controllableWeakRefs()
    const tracker = createFrontendMemoryTracker({
      reporterId: "12345678-1234-4234-8234-123456789abc",
      send: async () => {},
    })
    const turn = { text: "private reply" }
    tracker.recordRuntimeRetirement("session", { turns: [turn] })
    tracker.recordRuntimeRetirement("turn", turn)
    tracker.recordRuntimeRetirement("turn", turn)
    expect(tracker.sample().metrics).toMatchObject({
      runtimeSessionsRetired: 1,
      retiredRuntimeSessionsAlive: 1,
      runtimeTurnsRetired: 1,
      retiredRuntimeTurnsAlive: 1,
    })
    expect(JSON.stringify(tracker.sample())).not.toContain("private reply")

    for (const cell of cells) cell.target = undefined
    expect(tracker.sample().metrics).toMatchObject({
      runtimeSessionsRetired: 1,
      retiredRuntimeSessionsAlive: 0,
      runtimeTurnsRetired: 1,
      retiredRuntimeTurnsAlive: 0,
    })
  })

  it("does not mistake a reclaimed view or an obsolete cleanup for retirement", () => {
    const cells = controllableWeakRefs()
    const tracker = createFrontendMemoryTracker({
      reporterId: "12345678-1234-4234-8234-123456789abc",
      send: async () => {},
    })
    const view = {}
    const first = tracker.registerMessageView(view)
    first()
    first()
    expect(tracker.sample().metrics).toMatchObject({
      messageViewsRetired: 1,
      retiredMessageViewsAlive: 1,
    })
    const second = tracker.registerMessageView(view)
    first()
    expect(tracker.sample().metrics.retiredMessageViewsAlive).toBe(0)
    second()
    expect(tracker.sample().metrics).toMatchObject({
      messageViewsRetired: 2,
      retiredMessageViewsAlive: 1,
    })
    for (const cell of cells) cell.target = undefined
    expect(tracker.sample().metrics.retiredMessageViewsAlive).toBe(0)
  })

  it("bounds lifetime observations and ignores cleanup after disposal", () => {
    controllableWeakRefs()
    const tracker = createFrontendMemoryTracker({
      reporterId: "12345678-1234-4234-8234-123456789abc",
      send: async () => {},
    })
    for (let i = 0; i < 130; i++) {
      tracker.recordRuntimeRetirement("session", {})
      tracker.recordRuntimeRetirement("turn", {})
      tracker.registerMessageView({})()
    }
    expect(tracker.sample().metrics).toMatchObject({
      retiredRuntimeSessionsAlive: 128,
      retiredRuntimeTurnsAlive: 128,
      retiredMessageViewsAlive: 128,
      lifetimeTrackersDropped: 6,
    })
    const late = tracker.registerMessageView({})
    tracker.dispose()
    late()
    tracker.recordRuntimeRetirement("session", {})
    expect(tracker.sample().metrics).toMatchObject({
      retiredRuntimeSessionsAlive: 0,
      retiredRuntimeTurnsAlive: 0,
      retiredMessageViewsAlive: 0,
    })
  })

  it("records visibility and focus as numbers without keeping page metadata", () => {
    let state = { hidden: true, focused: false }
    const tracker = createFrontendMemoryTracker({
      reporterId: "12345678-1234-4234-8234-123456789abc",
      documentState: () => state,
      send: async () => {},
    })
    expect(tracker.sample().metrics).toMatchObject({
      documentHidden: 1,
      documentFocused: 0,
    })
    state = { hidden: false, focused: true }
    expect(tracker.sample().metrics).toMatchObject({
      documentHidden: 0,
      documentFocused: 1,
    })
  })

  it("makes retirement tracking a no-op when WeakRef is unavailable", () => {
    vi.stubGlobal("WeakRef", undefined)
    const tracker = createFrontendMemoryTracker({
      reporterId: "12345678-1234-4234-8234-123456789abc",
      send: async () => {},
    })
    tracker.registerMessageView({})()
    tracker.recordRuntimeRetirement("turn", {})
    expect(tracker.sample().metrics).toMatchObject({
      weakRefsAvailable: 0,
      messageViewsRetired: 0,
      runtimeTurnsRetired: 0,
    })
  })
})
