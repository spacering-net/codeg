import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  desktop: true,
  remote: false,
  call: vi.fn(),
  subscribe: vi.fn(),
  release: vi.fn(),
  browser: vi.fn(() => ({ domElements: 12 })),
  disconnect: vi.fn(),
}))

vi.mock("./transport", () => ({
  isDesktop: () => mocks.desktop,
  isRemoteDesktopMode: () => mocks.remote,
  getShellTransport: () => ({ call: mocks.call, subscribe: mocks.subscribe }),
}))
vi.mock("./frontend-memory-browser", () => ({
  readBrowserMemoryCounters: mocks.browser,
}))
vi.mock("./frontend-memory-activity", () => ({
  createDomMutationMemoryCounters: () => ({
    read: () => ({}),
    dispose: mocks.disconnect,
  }),
  readTauriMemoryCalls: () => ({}),
}))

async function settle() {
  for (let i = 0; i < 35; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.stubEnv("NEXT_PUBLIC_CODEG_MEMORY_DIAGNOSTICS", "1")
  mocks.desktop = true
  mocks.remote = false
  vi.clearAllMocks()
  mocks.subscribe.mockResolvedValue(mocks.release)
  mocks.call.mockImplementation(async (command: string) => {
    if (command === "get_frontend_memory_control")
      return {
        epoch: 0,
        reportingEnabled: true,
        browserCountersEnabled: true,
        sampleSequence: 0,
      }
  })
})

afterEach(() => {
  window.dispatchEvent(new PageTransitionEvent("pagehide"))
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe("renderer memory controller lifetime", () => {
  it("keeps periodic reports inactive after rejected control registration and still cleans up", async () => {
    mocks.subscribe.mockRejectedValue(new Error("registration unavailable"))
    const { registerFrontendMemorySurface } = await import("./frontend-memory")
    registerFrontendMemorySurface()
    await settle()
    await vi.advanceTimersByTimeAsync(45_000)
    expect(mocks.call).not.toHaveBeenCalled()
    expect(mocks.browser).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    window.dispatchEvent(new PageTransitionEvent("pagehide"))
    expect(mocks.disconnect).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("does no eager sample, preserves bfcache and releases the timer/listener/observer on navigation", async () => {
    const { registerFrontendMemorySurface } = await import("./frontend-memory")
    const releaseSurface = registerFrontendMemorySurface()
    await settle()
    expect(mocks.browser).not.toHaveBeenCalled()
    expect(mocks.subscribe).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(
      mocks.call.mock.calls.filter(
        ([command]) => command === "report_frontend_memory"
      )
    ).toHaveLength(1)
    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: true })
    )
    expect(mocks.release).not.toHaveBeenCalled()
    window.dispatchEvent(new PageTransitionEvent("pagehide"))
    expect(mocks.release).toHaveBeenCalledTimes(1)
    expect(mocks.disconnect).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    releaseSurface()
    registerFrontendMemorySurface()
    await settle()
    expect(mocks.subscribe).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
  })

  it.each(["disabled", "web", "remote"])(
    "allocates no diagnostics timer or listener in %s mode",
    async (kind) => {
      if (kind === "disabled")
        vi.stubEnv("NEXT_PUBLIC_CODEG_MEMORY_DIAGNOSTICS", "0")
      if (kind === "web") mocks.desktop = false
      if (kind === "remote") mocks.remote = true
      const { registerFrontendMemorySurface } =
        await import("./frontend-memory")
      registerFrontendMemorySurface()
      await settle()
      expect(vi.getTimerCount()).toBe(0)
      expect(mocks.subscribe).not.toHaveBeenCalled()
      expect(mocks.call).not.toHaveBeenCalled()
      expect(mocks.browser).not.toHaveBeenCalled()
    }
  )
})
