import { useRef } from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { ROW_FOCUSED, ROW_POINTED, useRowPointing } from "./use-row-pointing"

/** The pointer leaving `from` for `to` (jsdom's pointer events carry no
 *  `relatedTarget`, a mouse event's do). */
function pointerOut(from: Element, to: Element) {
  fireEvent(
    from,
    new MouseEvent("pointerout", { bubbles: true, relatedTarget: to })
  )
}

/** A goal's row holding a step of its own, as a timeline draws them. */
function Timeline() {
  const listRef = useRef<HTMLOListElement>(null)
  useRowPointing(listRef, true)
  return (
    <ol ref={listRef}>
      <li className="activity-item" data-testid="goal">
        <span className="activity-marker" />
        <div>
          <button className="activity-row-toggle" data-testid="goal-toggle">
            <span data-testid="goal-label">Goal</span>
          </button>
          <ol>
            <li className="activity-item" data-testid="step">
              <span className="activity-marker" />
              <button className="activity-row-toggle" data-testid="step-toggle">
                Ran 3 commands
              </button>
            </li>
          </ol>
        </div>
      </li>
      <li className="activity-item" data-testid="note">
        <span>Plain prose</span>
      </li>
    </ol>
  )
}

describe("useRowPointing", () => {
  it("marks the row whose own button is pointed at, and only it", () => {
    render(<Timeline />)
    const goal = screen.getByTestId("goal")
    const step = screen.getByTestId("step")

    fireEvent.pointerOver(screen.getByTestId("goal-label"))
    expect(goal).toHaveAttribute(ROW_POINTED)
    expect(step).not.toHaveAttribute(ROW_POINTED)

    // Moving within the button keeps it.
    pointerOut(
      screen.getByTestId("goal-label"),
      screen.getByTestId("goal-toggle")
    )
    expect(goal).toHaveAttribute(ROW_POINTED)

    // The nested row's button marks the nested row, not the goal around it.
    pointerOut(
      screen.getByTestId("goal-toggle"),
      screen.getByTestId("step-toggle")
    )
    fireEvent.pointerOver(screen.getByTestId("step-toggle"))
    expect(goal).not.toHaveAttribute(ROW_POINTED)
    expect(step).toHaveAttribute(ROW_POINTED)

    pointerOut(screen.getByTestId("step-toggle"), screen.getByTestId("note"))
    expect(step).not.toHaveAttribute(ROW_POINTED)
  })

  it("leaves a row without a button alone", () => {
    render(<Timeline />)
    const note = screen.getByTestId("note")
    fireEvent.pointerOver(note)
    expect(note).not.toHaveAttribute(ROW_POINTED)
  })

  it("marks the row whose button has focus, until it goes", () => {
    render(<Timeline />)
    const toggle = screen.getByTestId("step-toggle")
    const step = screen.getByTestId("step")
    act(() => toggle.focus())
    expect(step).toHaveAttribute(ROW_FOCUSED)
    expect(screen.getByTestId("goal")).not.toHaveAttribute(ROW_FOCUSED)
    act(() => toggle.blur())
    expect(step).not.toHaveAttribute(ROW_FOCUSED)
  })

  it("clears the mark of a button taken out while focused at the next focus", () => {
    render(<Timeline />)
    const step = screen.getByTestId("step")
    const toggle = screen.getByTestId("step-toggle")
    act(() => toggle.focus())
    expect(step).toHaveAttribute(ROW_FOCUSED)
    // Replaced while focused (an answered question expanding): no focusout.
    act(() => toggle.remove())
    act(() => screen.getByTestId("goal-toggle").focus())
    expect(step).not.toHaveAttribute(ROW_FOCUSED)
    expect(screen.getByTestId("goal")).toHaveAttribute(ROW_FOCUSED)
  })
})
