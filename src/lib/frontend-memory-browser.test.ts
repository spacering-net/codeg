import { afterEach, describe, expect, it, vi } from "vitest"
import { readBrowserMemoryCounters } from "./frontend-memory-browser"

afterEach(() => vi.unstubAllGlobals())

function browserGlobals(optionalApis: boolean) {
  const readPrivate = vi.fn(() => {
    throw new Error("Private contents must never be inspected")
  })
  vi.stubGlobal("document", {
    getElementsByTagName: (tag: string) => ({
      length: tag === "*" ? 200 : 2,
      get textContent() {
        return readPrivate()
      },
    }),
    getElementsByClassName: () => ({ length: 1 }),
    ...(optionalApis
      ? {
          getAnimations: () => [
            {
              playState: "running",
              get effect() {
                return readPrivate()
              },
            },
            { playState: "finished" },
          ],
        }
      : {}),
  })
  vi.stubGlobal("performance", {
    getEntriesByType: () => [
      {
        get name() {
          return readPrivate()
        },
      },
    ],
    ...(optionalApis ? { memory: { usedJSHeapSize: 1234 } } : {}),
  })
  vi.stubGlobal("window", {
    ...(optionalApis
      ? {
          __TAURI_INTERNALS__: {
            callbacks: {
              size: 9,
              get keys() {
                return readPrivate()
              },
              get values() {
                return readPrivate()
              },
            },
          },
        }
      : {}),
  })
  return readPrivate
}

describe("shallow browser memory counters", () => {
  it("returns numbers without examining callback, DOM or resource contents", () => {
    const readPrivate = browserGlobals(true)
    expect(readBrowserMemoryCounters()).toEqual({
      domElements: 200,
      domCanvases: 2,
      terminalElements: 1,
      resourceTimingEntries: 1,
      tauriCallbacks: 9,
      documentAnimations: 2,
      runningAnimations: 1,
      jsHeapUsedBytes: 1234,
    })
    expect(readPrivate).not.toHaveBeenCalled()
  })

  it("omits unavailable optional APIs instead of reporting zero", () => {
    browserGlobals(false)
    expect(readBrowserMemoryCounters()).toEqual({
      domElements: 200,
      domCanvases: 2,
      terminalElements: 1,
      resourceTimingEntries: 1,
    })
  })
})
