import { act, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useLongPressToOpenMenu } from "./use-long-press-to-open-menu"

/**
 * jsdom's `fireEvent.pointerDown` drops `pointerType` (it builds a plain
 * MouseEvent), so the tests below construct MouseEvent objects directly and
 * attach `pointerType` via `Object.defineProperty` — same pattern as
 * chat-input.test.tsx.
 */
function makePointerEvent(
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  target: Element,
  init: {
    clientX?: number
    clientY?: number
    pointerType: "mouse" | "touch" | "pen"
  }
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY,
  })
  Object.defineProperty(event, "pointerType", { value: init.pointerType })
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
  onContextMenu: ReturnType<typeof vi.fn>
}

function renderHost(
  options?: Parameters<typeof useLongPressToOpenMenu>[0]
): Fixture {
  const onContextMenu = vi.fn()
  function Harness() {
    const gesture = useLongPressToOpenMenu(options)
    return <div data-testid="host" onContextMenu={onContextMenu} {...gesture} />
  }
  const utils = render(<Harness />)
  const host = utils.container.querySelector(
    "[data-testid='host']"
  ) as HTMLElement
  return { host, onContextMenu }
}

describe("useLongPressToOpenMenu", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("ignores mouse pointerdown entirely", () => {
    const { host, onContextMenu } = renderHost()
    makePointerEvent("pointerdown", host, {
      pointerType: "mouse",
      clientX: 10,
      clientY: 20,
    })
    advance(1000)
    expect(onContextMenu).not.toHaveBeenCalled()
  })

  it("dispatches a synthetic contextmenu after longPressMs of a still touch", () => {
    const { host, onContextMenu } = renderHost()
    makePointerEvent("pointerdown", host, {
      pointerType: "touch",
      clientX: 50,
      clientY: 60,
    })
    advance(499)
    expect(onContextMenu).not.toHaveBeenCalled()

    advance(1)
    expect(onContextMenu).toHaveBeenCalledTimes(1)
    const event = onContextMenu.mock.calls[0][0] as MouseEvent
    expect(event.button).toBe(2)
    expect(event.clientX).toBe(50)
    expect(event.clientY).toBe(60)
    expect(event.bubbles).toBe(true)
    expect(event.cancelable).toBe(true)
  })

  it("also opens on a pen pointer", () => {
    const { host, onContextMenu } = renderHost()
    makePointerEvent("pointerdown", host, {
      pointerType: "pen",
      clientX: 5,
      clientY: 5,
    })
    advance(500)
    expect(onContextMenu).toHaveBeenCalledTimes(1)
  })

  it("cancels when the touch moves past the move threshold", () => {
    const { host, onContextMenu } = renderHost()
    makePointerEvent("pointerdown", host, {
      pointerType: "touch",
      clientX: 100,
      clientY: 100,
    })
    advance(300)
    makePointerEvent("pointermove", host, {
      pointerType: "touch",
      clientX: 120,
      clientY: 100,
    })
    advance(500)
    expect(onContextMenu).not.toHaveBeenCalled()
  })

  it("tolerates micro-moves under the threshold (a still touch)", () => {
    const { host, onContextMenu } = renderHost()
    makePointerEvent("pointerdown", host, {
      pointerType: "touch",
      clientX: 100,
      clientY: 100,
    })
    advance(200)
    makePointerEvent("pointermove", host, {
      pointerType: "touch",
      clientX: 103,
      clientY: 101,
    })
    makePointerEvent("pointermove", host, {
      pointerType: "touch",
      clientX: 105,
      clientY: 99,
    })
    advance(300)
    expect(onContextMenu).toHaveBeenCalledTimes(1)
  })

  it("cancels on pointerup", () => {
    const { host, onContextMenu } = renderHost()
    makePointerEvent("pointerdown", host, {
      pointerType: "touch",
      clientX: 0,
      clientY: 0,
    })
    advance(200)
    makePointerEvent("pointerup", host, { pointerType: "touch" })
    advance(500)
    expect(onContextMenu).not.toHaveBeenCalled()
  })

  it("cancels on pointercancel", () => {
    const { host, onContextMenu } = renderHost()
    makePointerEvent("pointerdown", host, {
      pointerType: "touch",
      clientX: 0,
      clientY: 0,
    })
    advance(200)
    makePointerEvent("pointercancel", host, { pointerType: "touch" })
    advance(500)
    expect(onContextMenu).not.toHaveBeenCalled()
  })

  it("a second touch during a still hold resets the timer", () => {
    const { host, onContextMenu } = renderHost()
    makePointerEvent("pointerdown", host, {
      pointerType: "touch",
      clientX: 0,
      clientY: 0,
    })
    advance(400)
    makePointerEvent("pointerdown", host, {
      pointerType: "touch",
      clientX: 0,
      clientY: 0,
    })
    advance(400)
    // First timer (500ms from t=0) would have fired at t=500 — but it was
    // cleared by the second pointerdown, and a fresh 500ms timer was armed.
    expect(onContextMenu).not.toHaveBeenCalled()
    advance(100)
    expect(onContextMenu).toHaveBeenCalledTimes(1)
  })

  it("disabled hook never fires", () => {
    const { host, onContextMenu } = renderHost({ enabled: false })
    makePointerEvent("pointerdown", host, {
      pointerType: "touch",
      clientX: 0,
      clientY: 0,
    })
    advance(1000)
    expect(onContextMenu).not.toHaveBeenCalled()
  })

  it("mouse pointermove after a touch hold doesn't cancel — pointerType is filtered", () => {
    const { host, onContextMenu } = renderHost()
    makePointerEvent("pointerdown", host, {
      pointerType: "touch",
      clientX: 0,
      clientY: 0,
    })
    advance(200)
    // A mouse move that happens to bubble through the same element must not
    // cancel an in-flight touch gesture.
    makePointerEvent("pointermove", host, {
      pointerType: "mouse",
      clientX: 1000,
      clientY: 1000,
    })
    advance(300)
    expect(onContextMenu).toHaveBeenCalledTimes(1)
  })
})
