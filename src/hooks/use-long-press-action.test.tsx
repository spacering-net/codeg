import { act, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useLongPressAction } from "./use-long-press-action"

/**
 * jsdom builds plain MouseEvents, so the tests below construct MouseEvent
 * objects directly and dispatch them on the host — same pattern as
 * use-long-press-to-open-menu.test.tsx. No `pointerType` is needed: this
 * hook treats mouse, touch, and pen identically.
 */
function fire(
  target: Element,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  init: { clientX?: number; clientY?: number; button?: number } = {}
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY,
    button: init.button,
  })
  target.dispatchEvent(event)
  return event
}

function fireClick(target: Element) {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

/** Advance vi's fake timers and flush React state queued by their callbacks. */
function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

interface Fixture {
  host: HTMLElement
  onPress: ReturnType<typeof vi.fn>
  onLongPress: ReturnType<typeof vi.fn>
}

function renderHarness(
  options?: Omit<Parameters<typeof useLongPressAction>[0], "onLongPress">
): Fixture {
  const onPress = vi.fn()
  const onLongPress = vi.fn()
  function Harness() {
    const { handlers } = useLongPressAction({
      onPress,
      onLongPress,
      ...options,
    })
    return <div data-testid="host" {...handlers} />
  }
  const utils = render(<Harness />)
  const host = utils.container.querySelector(
    "[data-testid='host']"
  ) as HTMLElement
  return { host, onPress, onLongPress }
}

describe("useLongPressAction", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("a quick tap calls onPress, not onLongPress", () => {
    const { host, onPress, onLongPress } = renderHarness()
    fire(host, "pointerdown", { clientX: 10, clientY: 20 })
    advance(100)
    fire(host, "pointerup")
    fireClick(host)
    advance(1000)
    expect(onPress).toHaveBeenCalledTimes(1)
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it("fires onLongPress after longPressMs of a still press", () => {
    const { host, onLongPress } = renderHarness()
    fire(host, "pointerdown", { clientX: 50, clientY: 60 })
    advance(499)
    expect(onLongPress).not.toHaveBeenCalled()
    advance(1)
    expect(onLongPress).toHaveBeenCalledTimes(1)
  })

  it("also fires for a mouse hold — there is no native long-press on desktop", () => {
    const { host, onLongPress } = renderHarness()
    fire(host, "pointerdown", { clientX: 0, clientY: 0 })
    advance(500)
    expect(onLongPress).toHaveBeenCalledTimes(1)
  })

  it("swallows the trailing click after a long press", () => {
    const { host, onPress, onLongPress } = renderHarness()
    fire(host, "pointerdown", { clientX: 0, clientY: 0 })
    advance(500)
    expect(onLongPress).toHaveBeenCalledTimes(1)
    fire(host, "pointerup")
    const click = fireClick(host)
    expect(onPress).not.toHaveBeenCalled()
    expect(click.defaultPrevented).toBe(true)
  })

  it("a fresh tap after a long press is not swallowed", () => {
    const { host, onPress } = renderHarness()
    // Long press whose trailing click never arrives (e.g. the element
    // unmounted first) must not poison the next interaction.
    fire(host, "pointerdown", { clientX: 0, clientY: 0 })
    advance(500)
    fire(host, "pointerdown", { clientX: 0, clientY: 0 })
    fire(host, "pointerup")
    fireClick(host)
    expect(onPress).toHaveBeenCalledTimes(1)
  })

  it("cancels when the press moves past the move threshold", () => {
    const { host, onPress, onLongPress } = renderHarness()
    fire(host, "pointerdown", { clientX: 100, clientY: 100 })
    advance(300)
    fire(host, "pointermove", { clientX: 120, clientY: 100 })
    advance(500)
    expect(onLongPress).not.toHaveBeenCalled()
    // The press was cancelled, so the click is a genuine tap again.
    fire(host, "pointerup")
    fireClick(host)
    expect(onPress).toHaveBeenCalledTimes(1)
  })

  it("tolerates micro-moves under the threshold", () => {
    const { host, onLongPress } = renderHarness()
    fire(host, "pointerdown", { clientX: 100, clientY: 100 })
    advance(200)
    fire(host, "pointermove", { clientX: 103, clientY: 101 })
    fire(host, "pointermove", { clientX: 105, clientY: 99 })
    advance(300)
    expect(onLongPress).toHaveBeenCalledTimes(1)
  })

  it("cancels on pointercancel", () => {
    const { host, onLongPress } = renderHarness()
    fire(host, "pointerdown", { clientX: 0, clientY: 0 })
    advance(200)
    fire(host, "pointercancel")
    advance(500)
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it("cancels on pointerup before the hold completes", () => {
    const { host, onLongPress } = renderHarness()
    fire(host, "pointerdown", { clientX: 0, clientY: 0 })
    advance(200)
    fire(host, "pointerup")
    advance(500)
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it("ignores non-primary buttons", () => {
    const { host, onLongPress } = renderHarness()
    fire(host, "pointerdown", { clientX: 0, clientY: 0, button: 2 })
    advance(1000)
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it("a second pointerdown during a still hold resets the timer", () => {
    const { host, onLongPress } = renderHarness()
    fire(host, "pointerdown", { clientX: 0, clientY: 0 })
    advance(400)
    fire(host, "pointerdown", { clientX: 0, clientY: 0 })
    advance(400)
    // First timer (500ms from t=0) would have fired at t=500 — but it was
    // cleared by the second pointerdown, and a fresh 500ms timer was armed.
    expect(onLongPress).not.toHaveBeenCalled()
    advance(100)
    expect(onLongPress).toHaveBeenCalledTimes(1)
  })

  it("default-prevents contextmenu so touch holds stay custom", () => {
    const { host } = renderHarness()
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    })
    host.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })
})
