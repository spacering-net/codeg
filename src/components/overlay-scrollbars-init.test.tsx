import { act, render } from "@testing-library/react"
import { OverlayScrollbars } from "overlayscrollbars"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const nav = vi.hoisted(() => ({ pathname: "/" }))

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
}))

import { OverlayScrollbarsInit } from "./overlay-scrollbars-init"

// Runs the real hook and the real library: the body instance is `defer`red
// into an idle callback that then waits for an animation frame. Both are
// queued here and only run when a test flushes them, so a test can keep an
// init pending across a route change, as a background tab does (frames do not
// run there).
const idle = new Map<number, () => void>()
const frames = new Map<number, FrameRequestCallback>()
let nextHandle = 0

function flushIdle() {
  act(() => {
    for (const [handle, callback] of [...idle]) {
      idle.delete(handle)
      callback()
    }
  })
}

function flushFrames() {
  act(() => {
    for (const [handle, callback] of [...frames]) {
      frames.delete(handle)
      callback(0)
    }
  })
}

function flushDeferred() {
  flushIdle()
  flushFrames()
}

// The static getter: the body's live instance, or undefined. Never creates.
const bodyInstance = () => OverlayScrollbars(document.body)

function navigate(rerender: (ui: React.ReactElement) => void, path: string) {
  nav.pathname = path
  rerender(<OverlayScrollbarsInit />)
}

beforeEach(() => {
  nav.pathname = "/"
  vi.stubGlobal("requestIdleCallback", (callback: () => void) => {
    idle.set(++nextHandle, callback)
    return nextHandle
  })
  vi.stubGlobal("cancelIdleCallback", (handle: number) => idle.delete(handle))
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextHandle, callback)
    return nextHandle
  })
  vi.stubGlobal("cancelAnimationFrame", (handle: number) =>
    frames.delete(handle)
  )
})

afterEach(() => {
  idle.clear()
  frames.clear()
  vi.unstubAllGlobals()
})

describe("OverlayScrollbarsInit", () => {
  it("creates the body instance, deferred, on a page that scrolls", () => {
    nav.pathname = "/settings/appearance"
    render(<OverlayScrollbarsInit />)
    expect(bodyInstance()).toBeUndefined()

    flushDeferred()

    expect(bodyInstance()).toBeDefined()
  })

  it("never creates one on the workspace", () => {
    nav.pathname = "/workspace"
    render(<OverlayScrollbarsInit />)
    flushDeferred()

    expect(bodyInstance()).toBeUndefined()
    expect(idle.size + frames.size).toBe(0)
  })

  it("destroys the instance when `/` hands over to the workspace", () => {
    const { rerender } = render(<OverlayScrollbarsInit />)
    flushDeferred()
    expect(bodyInstance()).toBeDefined()

    navigate(rerender, "/workspace")

    expect(bodyInstance()).toBeUndefined()
    expect(
      document.documentElement.hasAttribute("data-overlayscrollbars")
    ).toBe(false)
  })

  it("cancels an init still pending when the workspace is reached", () => {
    const { rerender } = render(<OverlayScrollbarsInit />)
    expect(idle.size + frames.size).toBeGreaterThan(0)

    navigate(rerender, "/workspace")
    flushDeferred()

    expect(bodyInstance()).toBeUndefined()
  })

  it("cancels an init already waiting for its frame, as in a hidden tab", () => {
    const { rerender } = render(<OverlayScrollbarsInit />)
    flushIdle()
    expect(frames.size).toBeGreaterThan(0)

    navigate(rerender, "/workspace")
    flushFrames()

    expect(bodyInstance()).toBeUndefined()
  })

  it("keeps the same instance across pages that scroll", () => {
    nav.pathname = "/settings/appearance"
    const { rerender } = render(<OverlayScrollbarsInit />)
    flushDeferred()
    const instance = bodyInstance()
    expect(instance).toBeDefined()

    navigate(rerender, "/settings/general")

    expect(bodyInstance()).toBe(instance)
  })
})
