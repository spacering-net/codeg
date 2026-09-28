import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  acquireNativeSurfaceOcclusion,
  acquireNativeSurfaceOcclusionFor,
  isNativeSurfaceOccluded,
  isNativeSurfaceOcclusionPassive,
  nativeSurfaceOcclusionHolders,
  requestNativeSurfaceReclaim,
  resetNativeSurfaceOcclusionForTests,
  subscribeNativeSurfaceOcclusion,
  subscribeNativeSurfaceReclaim,
  useFallbackOverlayOpen,
  useNativeSurfaceOccluded,
  useNativeSurfaceOcclusion,
  useNativeSurfaceOcclusionRef,
} from "./native-surface-occlusion"

describe("native surface occlusion leases", () => {
  beforeEach(() => resetNativeSurfaceOcclusionForTests())
  afterEach(() => {
    resetNativeSurfaceOcclusionForTests()
    document.body.innerHTML = ""
  })

  it("counts holders and notifies only on the 0↔1 edges", () => {
    const listener = vi.fn()
    subscribeNativeSurfaceOcclusion(listener)
    const releaseA = acquireNativeSurfaceOcclusion("dialog")
    const releaseB = acquireNativeSurfaceOcclusion("dialog")
    const releaseC = acquireNativeSurfaceOcclusion("menu")
    expect(isNativeSurfaceOccluded()).toBe(true)
    expect(nativeSurfaceOcclusionHolders()).toEqual({ dialog: 2, menu: 1 })
    expect(listener).toHaveBeenCalledTimes(1)
    releaseA()
    releaseA() // double release is a no-op
    expect(isNativeSurfaceOccluded()).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
    releaseB()
    releaseC()
    expect(isNativeSurfaceOccluded()).toBe(false)
    expect(nativeSurfaceOcclusionHolders()).toEqual({})
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("useNativeSurfaceOcclusion holds a lease while mounted and active", () => {
    const { result } = renderHook(() => useNativeSurfaceOccluded())
    const holder = renderHook(
      ({ active }: { active: boolean }) =>
        useNativeSurfaceOcclusion("drawer", active),
      { initialProps: { active: true } }
    )
    expect(result.current).toBe(true)
    act(() => holder.rerender({ active: false }))
    expect(result.current).toBe(false)
    act(() => holder.rerender({ active: true }))
    expect(result.current).toBe(true)
    act(() => holder.unmount())
    expect(result.current).toBe(false)
  })

  // A toast holds the surfaces down like anything else, but the hosts treat
  // it differently — so "is anything holding this down" and "is a notice all
  // that is" are two answers, and a change in either has to be published.
  it("tells a notice-only hold from one an overlay is part of", () => {
    const listener = vi.fn()
    subscribeNativeSurfaceOcclusion(listener)
    const releaseToast = acquireNativeSurfaceOcclusion("toast", {
      passive: true,
    })
    expect(isNativeSurfaceOccluded()).toBe(true)
    expect(isNativeSurfaceOcclusionPassive()).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)

    // The count does not change on the edge that matters here: what changes
    // is whose hold it is.
    const releaseDialog = acquireNativeSurfaceOcclusion("dialog")
    expect(isNativeSurfaceOccluded()).toBe(true)
    expect(isNativeSurfaceOcclusionPassive()).toBe(false)
    expect(listener).toHaveBeenCalledTimes(2)

    releaseDialog()
    expect(isNativeSurfaceOcclusionPassive()).toBe(true)
    expect(listener).toHaveBeenCalledTimes(3)

    releaseToast()
    releaseToast() // double release is a no-op here too
    expect(isNativeSurfaceOccluded()).toBe(false)
    expect(isNativeSurfaceOcclusionPassive()).toBe(false)
    expect(nativeSurfaceOcclusionHolders()).toEqual({})
    expect(listener).toHaveBeenCalledTimes(4)
  })

  it("carries the reclaim signal to whoever is holding a notice", () => {
    const holder = vi.fn()
    const stop = subscribeNativeSurfaceReclaim(holder)
    requestNativeSurfaceReclaim()
    expect(holder).toHaveBeenCalledTimes(1)
    stop()
    requestNativeSurfaceReclaim()
    expect(holder).toHaveBeenCalledTimes(1)
  })

  it("the fallback detector sees lease-less open dialogs and menus", async () => {
    const { result } = renderHook(() => useFallbackOverlayOpen())
    expect(result.current).toBe(false)
    const dialog = document.createElement("div")
    dialog.setAttribute("role", "dialog")
    dialog.setAttribute("data-state", "open")
    await act(async () => {
      document.body.appendChild(dialog)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(result.current).toBe(true)
    await act(async () => {
      dialog.setAttribute("data-state", "closed")
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(result.current).toBe(false)
  })
})

describe("DOM-bound leases", () => {
  it("useNativeSurfaceOcclusionRef holds a lease only while attached to a node", () => {
    resetNativeSurfaceOcclusionForTests()
    const { result } = renderHook(() => useNativeSurfaceOcclusionRef("menu"))
    expect(isNativeSurfaceOccluded()).toBe(false)
    const node = document.createElement("div")
    act(() => result.current(node))
    expect(isNativeSurfaceOccluded()).toBe(true)
    act(() => result.current(node)) // re-attach is not a second lease
    expect(nativeSurfaceOcclusionHolders()).toEqual({ menu: 1 })
    act(() => result.current(null))
    expect(isNativeSurfaceOccluded()).toBe(false)
  })

  it("acquireNativeSurfaceOcclusionFor is a no-op when inactive", () => {
    resetNativeSurfaceOcclusionForTests()
    const release = acquireNativeSurfaceOcclusionFor("drawer", false)
    expect(isNativeSurfaceOccluded()).toBe(false)
    release()
    const release2 = acquireNativeSurfaceOcclusionFor("drawer", true)
    expect(isNativeSurfaceOccluded()).toBe(true)
    release2()
    expect(isNativeSurfaceOccluded()).toBe(false)
  })
})
