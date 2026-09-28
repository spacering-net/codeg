import type { PointerEvent as ReactPointerEvent } from "react"
import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  PINNED_ROW_ATTR,
  pinInsertionIndex,
  reorderedPinIds,
  usePinnedPointerReorder,
} from "./use-pinned-pointer-reorder"

describe("reorderedPinIds", () => {
  const ids = [10, 20, 30, 40]

  it("moves a row up to the drop slot", () => {
    expect(reorderedPinIds(ids, 30, 0)).toEqual([30, 10, 20, 40])
  })

  it("moves a row down: the slot index counts the row being moved", () => {
    // Slot 3 sits between 30 and 40, so 10 lands after 30.
    expect(reorderedPinIds(ids, 10, 3)).toEqual([20, 30, 10, 40])
    // Past the end.
    expect(reorderedPinIds(ids, 10, 4)).toEqual([20, 30, 40, 10])
  })

  it("reports no change for a drop right above or below the row itself", () => {
    expect(reorderedPinIds(ids, 20, 1)).toBeNull()
    expect(reorderedPinIds(ids, 20, 2)).toBeNull()
  })

  it("ignores an id that is not pinned", () => {
    expect(reorderedPinIds(ids, 99, 0)).toBeNull()
  })
})

describe("pinInsertionIndex", () => {
  const ids = [10, 20, 30, 40]

  it("counts the mounted rows whose midpoint is above the pointer", () => {
    // 32px rows stacked from y=0: midpoints 16, 48, 80, 112.
    const rows = ids.map((id, index) => ({ id, midY: index * 32 + 16 }))
    expect(pinInsertionIndex(ids, rows, 0)).toBe(0)
    expect(pinInsertionIndex(ids, rows, 60)).toBe(2)
    expect(pinInsertionIndex(ids, rows, 500)).toBe(4)
  })

  it("stays true to the full order when leading rows are virtualized away", () => {
    // Only 30 and 40 are mounted; 10 and 20 are scrolled far above.
    const rows = [
      { id: 30, midY: 16 },
      { id: 40, midY: 48 },
    ]
    expect(pinInsertionIndex(ids, rows, 0)).toBe(2)
    expect(pinInsertionIndex(ids, rows, 30)).toBe(3)
    expect(pinInsertionIndex(ids, rows, 60)).toBe(4)
  })

  it("is null when no pinned row is mounted", () => {
    expect(pinInsertionIndex(ids, [], 10)).toBeNull()
    expect(pinInsertionIndex(ids, [{ id: 99, midY: 16 }], 10)).toBeNull()
  })
})

// jsdom has no PointerEvent and no layout, so the gesture is driven with plain
// events carrying the pointer fields, and every row reports a fixed 32px box.
function firePointer(type: string, clientY: number) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, { pointerId: 1, button: 0, clientX: 0, clientY })
  act(() => {
    window.dispatchEvent(event)
  })
}

describe("usePinnedPointerReorder", () => {
  const ids = [10, 20, 30, 40]
  const rows = new Map<number, HTMLElement>()

  beforeEach(() => {
    ids.forEach((id, index) => {
      const row = document.createElement("div")
      row.setAttribute(PINNED_ROW_ATTR, String(id))
      row.getBoundingClientRect = () =>
        ({ top: index * 32, height: 32 }) as DOMRect
      // The row body (the drag handle) and one of the row's own controls.
      const body = document.createElement("button")
      body.setAttribute("data-conversation-id", String(id))
      row.appendChild(body)
      row.appendChild(document.createElement("button"))
      document.body.appendChild(row)
      rows.set(id, row)
    })
  })

  afterEach(() => {
    // A finished drag leaves a one-shot click swallower on window until the
    // next task; drain it so it cannot eat a later test's click.
    window.dispatchEvent(new MouseEvent("click"))
    rows.forEach((row) => row.remove())
    rows.clear()
  })

  function rowBody(id: number): HTMLElement {
    return rows.get(id)!.querySelector<HTMLElement>("[data-conversation-id]")!
  }

  function press(
    id: number,
    clientY: number,
    overrides: { button?: number; pointerType?: string; target?: Element } = {}
  ): ReactPointerEvent {
    return {
      button: 0,
      pointerType: "mouse",
      pointerId: 1,
      clientY,
      target: rowBody(id),
      currentTarget: rows.get(id),
      ...overrides,
    } as unknown as ReactPointerEvent
  }

  function setup() {
    const onCommit = vi.fn()
    const { result } = renderHook(() =>
      usePinnedPointerReorder({ pinnedIds: ids, onCommit })
    )
    return { onCommit, result }
  }

  it("drags a row past the threshold and commits the new order on release", () => {
    const { onCommit, result } = setup()
    act(() => result.current.beginPinDrag(10, press(10, 16)))

    // Under the 4px threshold it is still just a press.
    firePointer("pointermove", 19)
    expect(result.current.draggingId).toBeNull()

    // Below the midpoints of 20 and 30: the drop slot is 3.
    firePointer("pointermove", 90)
    expect(result.current.draggingId).toBe(10)
    expect(result.current.dropIndex).toBe(3)
    expect(document.body.style.userSelect).toBe("none")

    firePointer("pointerup", 90)
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith([20, 30, 10, 40])
    expect(result.current.draggingId).toBeNull()
    expect(result.current.dropIndex).toBeNull()
    expect(document.body.style.userSelect).toBe("")
  })

  it("does not commit a drop that leaves the order unchanged", () => {
    const { onCommit, result } = setup()
    act(() => result.current.beginPinDrag(20, press(20, 48)))
    firePointer("pointermove", 60)
    firePointer("pointerup", 60)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it("swallows the click that ends a drag, but not a plain click", () => {
    const { result } = setup()
    const opened = vi.fn()
    rowBody(10).addEventListener("click", opened)

    act(() => result.current.beginPinDrag(10, press(10, 16)))
    firePointer("pointerup", 16)
    rowBody(10).click()
    expect(opened).toHaveBeenCalledTimes(1)

    act(() => result.current.beginPinDrag(10, press(10, 16)))
    firePointer("pointermove", 90)
    firePointer("pointerup", 90)
    rowBody(10).click()
    expect(opened).toHaveBeenCalledTimes(1)
  })

  it("cancels on Escape and on pointercancel without committing", () => {
    const { onCommit, result } = setup()

    act(() => result.current.beginPinDrag(10, press(10, 16)))
    firePointer("pointermove", 90)
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
    })
    expect(result.current.draggingId).toBeNull()
    firePointer("pointerup", 90)

    act(() => result.current.beginPinDrag(10, press(10, 16)))
    firePointer("pointermove", 90)
    firePointer("pointercancel", 90)
    expect(result.current.draggingId).toBeNull()
    firePointer("pointerup", 90)

    expect(onCommit).not.toHaveBeenCalled()
  })

  it("starts only from a primary mouse or pen press on the row body", () => {
    const { onCommit, result } = setup()
    const portal = document.createElement("div")
    document.body.appendChild(portal)
    const attempts = [
      press(10, 16, { pointerType: "touch" }),
      press(10, 16, { button: 2 }),
      // One of the row's own controls (pin, status, expand).
      press(10, 16, { target: rows.get(10)!.lastElementChild! }),
      // A press inside a portal (context menu, dialog) that React bubbled up
      // through the row.
      press(10, 16, { target: portal }),
    ]
    for (const event of attempts) {
      act(() => result.current.beginPinDrag(10, event))
      firePointer("pointermove", 90)
      expect(result.current.draggingId).toBeNull()
      firePointer("pointerup", 90)
    }
    expect(onCommit).not.toHaveBeenCalled()
    portal.remove()
  })
})
