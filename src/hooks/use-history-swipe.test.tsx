import { render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { useHistorySwipe } from "./use-history-swipe"

/**
 * jsdom builds plain MouseEvents, so the tests dispatch them on the host —
 * same pattern as use-long-press-action.test.tsx. The hook reads only
 * clientX/clientY, so no pointerType is needed.
 */
function fire(
  target: Element,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  init: { clientX?: number; clientY?: number } = {}
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY,
  })
  target.dispatchEvent(event)
  return event
}

function renderHarness() {
  const onSwipe = vi.fn()
  function Harness() {
    const { handlers } = useHistorySwipe({ onSwipe })
    return <div data-testid="host" {...handlers} />
  }
  const utils = render(<Harness />)
  const host = utils.container.querySelector(
    "[data-testid='host']"
  ) as HTMLElement
  return { host, onSwipe }
}

describe("useHistorySwipe", () => {
  it("a right swipe fires newer", () => {
    const { host, onSwipe } = renderHarness()
    fire(host, "pointerdown", { clientX: 100, clientY: 100 })
    fire(host, "pointermove", { clientX: 150, clientY: 101 })
    expect(onSwipe).toHaveBeenCalledTimes(1)
    expect(onSwipe).toHaveBeenCalledWith("newer")
  })

  it("a left swipe fires older", () => {
    const { host, onSwipe } = renderHarness()
    fire(host, "pointerdown", { clientX: 150, clientY: 100 })
    fire(host, "pointermove", { clientX: 100, clientY: 99 })
    expect(onSwipe).toHaveBeenCalledTimes(1)
    expect(onSwipe).toHaveBeenCalledWith("older")
  })

  it("movement under the threshold never fires", () => {
    const { host, onSwipe } = renderHarness()
    fire(host, "pointerdown", { clientX: 100, clientY: 100 })
    fire(host, "pointermove", { clientX: 147, clientY: 100 })
    fire(host, "pointerup", { clientX: 140, clientY: 100 })
    expect(onSwipe).not.toHaveBeenCalled()
  })

  it("a vertical drag (dy > dx / 1.5) never fires", () => {
    const { host, onSwipe } = renderHarness()
    fire(host, "pointerdown", { clientX: 100, clientY: 100 })
    // 40px right but 30px down: ratio 1.33 < 1.5 — a scroll flick, not a swipe.
    fire(host, "pointermove", { clientX: 140, clientY: 130 })
    fire(host, "pointerup")
    expect(onSwipe).not.toHaveBeenCalled()
  })

  it("a horizontal drag tolerates some vertical drift", () => {
    const { host, onSwipe } = renderHarness()
    fire(host, "pointerdown", { clientX: 100, clientY: 100 })
    // 48px right, 30px down: ratio 1.6 > 1.5 — still a swipe.
    fire(host, "pointermove", { clientX: 148, clientY: 130 })
    expect(onSwipe).toHaveBeenCalledTimes(1)
  })

  it("fires at most once per touch — a long drag is one step", () => {
    const { host, onSwipe } = renderHarness()
    fire(host, "pointerdown", { clientX: 100, clientY: 100 })
    fire(host, "pointermove", { clientX: 150, clientY: 100 })
    fire(host, "pointermove", { clientX: 200, clientY: 100 })
    fire(host, "pointermove", { clientX: 260, clientY: 100 })
    expect(onSwipe).toHaveBeenCalledTimes(1)
  })

  it("a fresh touch after a swipe can fire again", () => {
    const { host, onSwipe } = renderHarness()
    fire(host, "pointerdown", { clientX: 100, clientY: 100 })
    fire(host, "pointermove", { clientX: 150, clientY: 100 })
    fire(host, "pointerup")
    fire(host, "pointerdown", { clientX: 150, clientY: 100 })
    fire(host, "pointermove", { clientX: 100, clientY: 100 })
    expect(onSwipe).toHaveBeenCalledTimes(2)
    expect(onSwipe).toHaveBeenLastCalledWith("older")
  })

  it("a move without a pointerdown is ignored", () => {
    const { host, onSwipe } = renderHarness()
    fire(host, "pointermove", { clientX: 200, clientY: 100 })
    fire(host, "pointerup")
    expect(onSwipe).not.toHaveBeenCalled()
  })

  it("a tap (down then up in place) never fires", () => {
    const { host, onSwipe } = renderHarness()
    fire(host, "pointerdown", { clientX: 100, clientY: 100 })
    fire(host, "pointerup", { clientX: 101, clientY: 100 })
    expect(onSwipe).not.toHaveBeenCalled()
  })
})
