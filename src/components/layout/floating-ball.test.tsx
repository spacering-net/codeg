import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

const appearance = vi.hoisted(() => ({
  enabled: false,
  position: null as { x: number; y: number } | null,
  setPosition: vi.fn(),
  bindings: {} as Record<string, string | null>,
  size: "large" as "small" | "medium" | "large",
  favoriteAgents: [] as string[],
}))

vi.mock("@/hooks/use-appearance", () => ({
  useFloatingBall: () => ({
    floatingBallEnabled: appearance.enabled,
    setFloatingBallEnabled: vi.fn(),
    floatingBallPosition: appearance.position,
    setFloatingBallPosition: appearance.setPosition,
    floatingBallBindings: appearance.bindings,
    setFloatingBallBindings: vi.fn(),
    floatingBallSize: appearance.size,
    setFloatingBallSize: vi.fn(),
    floatingBallFavoriteAgents: appearance.favoriteAgents,
    setFloatingBallFavoriteAgents: vi.fn(),
  }),
}))

import { FloatingBall } from "./floating-ball"

function renderBall(onAction = vi.fn()) {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <FloatingBall onAction={onAction} />
    </NextIntlClientProvider>
  )
  return onAction
}

/**
 * jsdom implements neither `PointerEvent` nor coordinates on it, so
 * `fireEvent.pointerDown(el, { clientX })` arrives with nulls. A `MouseEvent`
 * carrying the pointer event's type does reach React's handler with real
 * coordinates, which is all the component reads.
 */
function pointer(
  el: Element,
  type: "pointerdown" | "pointermove" | "pointerup",
  x: number,
  y: number,
  pointerId = 1
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  })
  Object.defineProperty(event, "pointerId", { value: pointerId })
  Object.defineProperty(event, "pointerType", { value: "touch" })
  fireEvent(el, event)
}

/** A press that never moves, held for `heldMs`. */
function tap(heldMs = 50) {
  const ball = screen.getByLabelText("Floating ball")
  pointer(ball, "pointerdown", 100, 100)
  vi.advanceTimersByTime(heldMs)
  pointer(ball, "pointerup", 100, 100)
  return ball
}

/** A press that moves in a straight line and releases. */
function swipe(from: [number, number], to: [number, number]) {
  const ball = screen.getByLabelText("Floating ball")
  pointer(ball, "pointerdown", from[0], from[1])
  // Within GESTURE_ONSET_MS, so this is a gesture and not a drag.
  pointer(
    ball,
    "pointermove",
    from[0] + (to[0] - from[0]) / 2,
    from[1] + (to[1] - from[1]) / 2
  )
  pointer(ball, "pointermove", to[0], to[1])
  pointer(ball, "pointerup", to[0], to[1])
}

beforeEach(() => {
  localStorage.clear()
  appearance.enabled = false
  appearance.position = null
  appearance.setPosition.mockClear()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe("FloatingBall", () => {
  it("renders nothing until the preference is enabled", () => {
    renderBall()
    expect(screen.queryByLabelText("Floating ball")).toBeNull()
  })

  it("shows the ball when enabled", () => {
    appearance.enabled = true
    renderBall()
    expect(screen.getByLabelText("Floating ball")).toBeInTheDocument()
  })

  it("defaults to the right edge, clear of the composer and status bar", () => {
    appearance.enabled = true
    renderBall()
    const ball = screen.getByLabelText("Floating ball") as HTMLElement
    const x = parseFloat(ball.style.left)
    const y = parseFloat(ball.style.top)
    // Flush to the trailing edge...
    expect(x).toBe(window.innerWidth - 46 - 18)
    // ...but well above the bottom, where the composer's send button and the
    // status bar's alerts/MCP badges sit.
    expect(y).toBe(Math.round(window.innerHeight * 0.55))
    expect(y).toBeLessThan(window.innerHeight - 46 - 18)
  })

  it("opens the action panel on a single tap, after the double-tap window", () => {
    appearance.enabled = true
    const onAction = renderBall()
    tap()
    // Deferred so a double tap does not flash the panel first.
    expect(screen.queryByRole("dialog")).toBeNull()
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(screen.getByText("New conversation")).toBeInTheDocument()
    expect(onAction).not.toHaveBeenCalled()
  })

  it("treats a second tap inside the window as a double tap", () => {
    appearance.enabled = true
    const onAction = renderBall()
    tap()
    act(() => {
      vi.advanceTimersByTime(100)
    })
    tap()
    expect(onAction).toHaveBeenCalledWith("toggleTerminal")
    // The pending single tap must not fire as well.
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(onAction).toHaveBeenCalledTimes(1)
  })

  it("opens the in-ball settings on a long press", () => {
    appearance.enabled = true
    const onAction = renderBall()
    tap(700)
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(screen.getByText("Reset position")).toBeInTheDocument()
    expect(onAction).not.toHaveBeenCalled()
  })

  it("fires the bound action for a swipe", () => {
    appearance.enabled = true
    const onAction = renderBall()
    // Left = new conversation.
    swipe([200, 300], [120, 300])
    expect(onAction).toHaveBeenCalledWith("newConversation")
  })

  it("recognises a two-stage trail", () => {
    appearance.enabled = true
    const onAction = renderBall()
    const ball = screen.getByLabelText("Floating ball")
    pointer(ball, "pointerdown", 200, 400)
    pointer(ball, "pointermove", 200, 360)
    pointer(ball, "pointermove", 200, 320)
    pointer(ball, "pointermove", 200, 400)
    pointer(ball, "pointermove", 200, 460)
    pointer(ball, "pointerup", 200, 460)
    // Up, then down = open folder.
    expect(onAction).toHaveBeenCalledWith("openFolder")
  })

  it("stores the new position after a drag", () => {
    appearance.enabled = true
    renderBall()
    const ball = screen.getByLabelText("Floating ball") as HTMLElement
    // The ball's own corner is what moves, not the pointer's, so the assertion
    // is on the delta from where it started.
    const startX = parseFloat(ball.style.left)
    const startY = parseFloat(ball.style.top)
    pointer(ball, "pointerdown", 300, 500)
    // Moving only after the onset window makes this a repositioning drag.
    act(() => {
      vi.advanceTimersByTime(400)
    })
    pointer(ball, "pointermove", 260, 440)
    pointer(ball, "pointerup", 260, 440)
    expect(appearance.setPosition).toHaveBeenCalled()
    const stored = appearance.setPosition.mock.calls[0][0] as {
      x: number
      y: number
    }
    expect(stored.x).toBe(startX - 40)
    expect(stored.y).toBe(startY - 60)
  })

  it("closes the panel on Escape", () => {
    appearance.enabled = true
    renderBall()
    tap()
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    fireEvent.keyDown(document, { key: "Escape" })
    expect(screen.queryByRole("dialog")).toBeNull()
  })
})
