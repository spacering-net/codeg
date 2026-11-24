import { useEffect } from "react"
import { renderHook } from "@testing-library/react"
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest"

import { useHistoryBackDismiss } from "./use-history-back-dismiss"

const DEPTH_KEY = "codegBackDismissDepth"

function depthOf(state: unknown): unknown {
  return (state as Record<string, unknown> | null)?.[DEPTH_KEY]
}

/** Resolves once the traversal has landed and every popstate listener ran. */
function traverse(step: () => void): Promise<void> {
  return new Promise((resolve) => {
    window.addEventListener("popstate", () => resolve(), { once: true })
    step()
  })
}
const goBack = () => traverse(() => window.history.back())
const goForward = () => traverse(() => window.history.forward())

describe("useHistoryBackDismiss", () => {
  let pushSpy: MockInstance

  beforeEach(() => {
    // Each case starts on an entry without a marker. Earlier cases leave
    // entries behind on purpose, and a marked entry on top would be taken
    // over instead of pushed.
    window.history.replaceState(null, "")
    pushSpy = vi.spyOn(window.history, "pushState")
  })
  afterEach(() => {
    pushSpy.mockRestore()
  })

  it("pushes one history entry while active and dismisses on back", async () => {
    const onDismiss = vi.fn()
    renderHook(() => useHistoryBackDismiss(true, onDismiss))
    expect(pushSpy).toHaveBeenCalledTimes(1)
    expect(depthOf(window.history.state)).toBe(1)

    await goBack()
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it("a StrictMode mount pushes once and a back still dismisses", async () => {
    const onDismiss = vi.fn()
    let setups = 0
    // StrictMode at the root: React 19 skips the double mount for a
    // StrictMode nested under a freshly placed wrapper component.
    renderHook(
      () => {
        useEffect(() => {
          setups += 1
        }, [])
        useHistoryBackDismiss(true, onDismiss)
      },
      { reactStrictMode: true }
    )
    // The double mount really ran (setup, cleanup, setup) and took its own
    // entry back instead of pushing a second one.
    expect(setups).toBe(2)
    expect(pushSpy).toHaveBeenCalledTimes(1)

    await goBack()
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it("re-activating on top of its own leftover entry does not push twice", async () => {
    const onDismiss = vi.fn()
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) =>
        useHistoryBackDismiss(active, onDismiss),
      { initialProps: { active: true } }
    )
    expect(pushSpy).toHaveBeenCalledTimes(1)
    rerender({ active: false })
    rerender({ active: true })
    expect(pushSpy).toHaveBeenCalledTimes(1)

    await goBack()
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it("a non-back close leaves the entry and absorbs the next back silently", async () => {
    const onDismiss = vi.fn()
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) =>
        useHistoryBackDismiss(active, onDismiss),
      { initialProps: { active: true } }
    )
    rerender({ active: false })

    await goBack()
    expect(depthOf(window.history.state)).toBeUndefined()
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it("stacked layers: back closes only the topmost one", async () => {
    const dismissA = vi.fn()
    const dismissB = vi.fn()
    renderHook(() => useHistoryBackDismiss(true, dismissA))
    renderHook(() => useHistoryBackDismiss(true, dismissB))
    expect(pushSpy).toHaveBeenCalledTimes(2)

    await goBack()
    expect(dismissB).toHaveBeenCalledTimes(1)
    expect(dismissA).not.toHaveBeenCalled()

    await goBack()
    expect(dismissA).toHaveBeenCalledTimes(1)
    expect(dismissB).toHaveBeenCalledTimes(1)
  })

  it("three stacked layers unwind one per back", async () => {
    const dismissA = vi.fn()
    const dismissB = vi.fn()
    const dismissC = vi.fn()
    renderHook(() => useHistoryBackDismiss(true, dismissA))
    renderHook(() => useHistoryBackDismiss(true, dismissB))
    renderHook(() => useHistoryBackDismiss(true, dismissC))

    await goBack()
    expect(dismissC).toHaveBeenCalledTimes(1)
    expect(dismissB).not.toHaveBeenCalled()
    expect(dismissA).not.toHaveBeenCalled()

    await goBack()
    expect(dismissB).toHaveBeenCalledTimes(1)
    expect(dismissA).not.toHaveBeenCalled()

    await goBack()
    expect(dismissA).toHaveBeenCalledTimes(1)
  })

  it("a forward onto an entry above leaves the layer below open", async () => {
    const dismissA = vi.fn()
    const dismissB = vi.fn()
    renderHook(() => useHistoryBackDismiss(true, dismissA))
    renderHook(() => useHistoryBackDismiss(true, dismissB))

    await goBack()
    expect(dismissB).toHaveBeenCalledTimes(1)

    await goForward()
    expect(dismissA).not.toHaveBeenCalled()

    // Back off the dead entry and then off A's own: only the second one
    // closes A.
    await goBack()
    expect(dismissA).not.toHaveBeenCalled()
    await goBack()
    expect(dismissA).toHaveBeenCalledTimes(1)
  })

  it("a layer that opens as another closes takes over its entry", async () => {
    const dismissSidebar = vi.fn()
    const dismissFile = vi.fn()
    const { rerender } = renderHook(
      ({ sidebar, file }: { sidebar: boolean; file: boolean }) => {
        useHistoryBackDismiss(sidebar, dismissSidebar)
        useHistoryBackDismiss(file, dismissFile)
      },
      { initialProps: { sidebar: true, file: false } }
    )
    expect(pushSpy).toHaveBeenCalledTimes(1)

    // Picking a file in the sidebar: the sidebar closes as the file view opens.
    rerender({ sidebar: false, file: true })
    expect(pushSpy).toHaveBeenCalledTimes(1)

    await goBack()
    expect(dismissFile).toHaveBeenCalledTimes(1)
    expect(dismissSidebar).not.toHaveBeenCalled()
    expect(depthOf(window.history.state)).toBeUndefined()
  })

  it("open/close cycles across layers do not pile up history entries", () => {
    const { rerender } = renderHook(
      ({ sidebar, file }: { sidebar: boolean; file: boolean }) => {
        useHistoryBackDismiss(sidebar, () => {})
        useHistoryBackDismiss(file, () => {})
      },
      { initialProps: { sidebar: false, file: false } }
    )
    for (let i = 0; i < 4; i++) {
      rerender({ sidebar: true, file: false })
      rerender({ sidebar: false, file: true })
      // Leaving the file view without a back (its last tab closed).
      rerender({ sidebar: false, file: false })
    }
    expect(pushSpy).toHaveBeenCalledTimes(1)
  })

  it("an entry left marked by an earlier page life is taken over, and a back still closes the layer", async () => {
    // A reload keeps the session history and its states; the page that wrote
    // these markers is gone, so nothing holds them.
    window.history.replaceState({ [DEPTH_KEY]: 1 }, "")
    window.history.pushState({ [DEPTH_KEY]: 2 }, "")
    pushSpy.mockClear()

    const onDismiss = vi.fn()
    renderHook(() => useHistoryBackDismiss(true, onDismiss))
    expect(pushSpy).not.toHaveBeenCalled()

    await goBack()
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
