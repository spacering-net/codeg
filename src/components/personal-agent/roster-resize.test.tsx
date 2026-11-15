import { act, cleanup, fireEvent, render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import enMessages from "@/i18n/messages/en.json"

import {
  clampRosterWidth,
  ROSTER_RAIL_KEY,
  ROSTER_RAIL_WIDTH,
  ROSTER_WIDTH_DEFAULT,
  ROSTER_WIDTH_KEY,
  ROSTER_WIDTH_MAX,
  ROSTER_WIDTH_MIN,
  RosterResizeHandle,
  rosterWidthOf,
  useRosterWidth,
} from "./roster-resize"

/** The roster's column with its handle, as the roster lays them out. */
function Column() {
  const [size, setSize] = useRosterWidth()
  return (
    <div style={{ display: "flex" }}>
      <nav
        data-column
        data-rail={size.rail || undefined}
        style={{ width: `${rosterWidthOf(size)}rem` }}
      />
      <RosterResizeHandle size={size} onSize={setSize} />
    </div>
  )
}

function draw() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <Column />
    </NextIntlClientProvider>
  )
}

/** jsdom has no PointerEvent: a MouseEvent of the pointer's type carries
 *  `button` and `clientX` the way Blink's does. */
function pointer(type: string, target: Element, clientX: number) {
  act(() => {
    target.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX,
      })
    )
  })
}

const column = () => document.querySelector<HTMLElement>("[data-column]")!
const handle = () =>
  document.querySelector<HTMLElement>("[data-pa-roster-resize]")!

beforeEach(() => window.localStorage.clear())
afterEach(cleanup)

describe("the roster's width", () => {
  it("starts at its default and keeps within its bounds", () => {
    draw()
    expect(column().style.width).toBe(`${ROSTER_WIDTH_DEFAULT}rem`)
    expect(handle().getAttribute("role")).toBe("separator")
    expect(handle().getAttribute("aria-orientation")).toBe("vertical")
    expect(clampRosterWidth(1)).toBe(ROSTER_WIDTH_MIN)
    expect(clampRosterWidth(99)).toBe(ROSTER_WIDTH_MAX)
    expect(clampRosterWidth(Number.NaN)).toBe(ROSTER_WIDTH_DEFAULT)
  })

  it("follows a drag, looks dragged meanwhile, and is kept for next time", () => {
    draw()
    // 16px a rem (jsdom's root has no font size of its own).
    pointer("pointerdown", handle(), 100)
    expect(handle().getAttribute("data-resize-handle-state")).toBe("drag")
    pointer("pointermove", handle(), 164)
    expect(column().style.width).toBe(`${ROSTER_WIDTH_DEFAULT + 4}rem`)
    // Not past its bound, however far it goes.
    pointer("pointermove", handle(), 2000)
    expect(column().style.width).toBe(`${ROSTER_WIDTH_MAX}rem`)
    pointer("pointermove", handle(), 132)
    pointer("pointerup", handle(), 132)
    expect(handle().getAttribute("data-resize-handle-state")).toBe("inactive")
    expect(window.localStorage.getItem(ROSTER_WIDTH_KEY)).toBe(
      String(ROSTER_WIDTH_DEFAULT + 2)
    )
    cleanup()
    draw()
    expect(column().style.width).toBe(`${ROSTER_WIDTH_DEFAULT + 2}rem`)
  })

  it("moves with the arrow keys and goes back on a double click", () => {
    draw()
    fireEvent.keyDown(handle(), { key: "ArrowRight" })
    expect(column().style.width).toBe(`${ROSTER_WIDTH_DEFAULT + 1}rem`)
    fireEvent.keyDown(handle(), { key: "End" })
    expect(column().style.width).toBe(`${ROSTER_WIDTH_MAX}rem`)
    fireEvent.keyDown(handle(), { key: "Home" })
    expect(column().style.width).toBe(`${ROSTER_RAIL_WIDTH}rem`)
    expect(column().hasAttribute("data-rail")).toBe(true)
    fireEvent.doubleClick(handle())
    expect(column().style.width).toBe(`${ROSTER_WIDTH_DEFAULT}rem`)
    expect(window.localStorage.getItem(ROSTER_WIDTH_KEY)).toBe(
      String(ROSTER_WIDTH_DEFAULT)
    )
  })

  it("folds to the rail dragged past halfway below its least width, and unfolds dragged out again", () => {
    draw()
    // From 15rem: to 12.5rem — still the list.
    pointer("pointerdown", handle(), 100)
    pointer("pointermove", handle(), 60)
    expect(column().style.width).toBe("12.5rem")
    // To 10rem: held at its least width, short of halfway to the rail.
    pointer("pointermove", handle(), 20)
    expect(column().style.width).toBe(`${ROSTER_WIDTH_MIN}rem`)
    expect(column().hasAttribute("data-rail")).toBe(false)
    // To 8rem, past halfway (8.625rem): the rail.
    pointer("pointermove", handle(), -12)
    expect(column().style.width).toBe(`${ROSTER_RAIL_WIDTH}rem`)
    expect(column().hasAttribute("data-rail")).toBe(true)
    expect(handle().getAttribute("aria-valuenow")).toBe(
      String(ROSTER_RAIL_WIDTH)
    )
    pointer("pointerup", handle(), -12)
    expect(window.localStorage.getItem(ROSTER_RAIL_KEY)).toBe("1")
    // The list's width is kept for when it unfolds by the keys.
    expect(window.localStorage.getItem(ROSTER_WIDTH_KEY)).toBe(
      String(ROSTER_WIDTH_DEFAULT)
    )
    cleanup()
    draw()
    expect(column().style.width).toBe(`${ROSTER_RAIL_WIDTH}rem`)
    // Out of the rail: from 5.25rem to 9rem unfolds it, at its least width;
    // on to 14rem, it follows.
    pointer("pointerdown", handle(), 0)
    pointer("pointermove", handle(), 60)
    expect(column().style.width).toBe(`${ROSTER_WIDTH_MIN}rem`)
    expect(column().hasAttribute("data-rail")).toBe(false)
    pointer("pointermove", handle(), 140)
    expect(column().style.width).toBe("14rem")
    pointer("pointerup", handle(), 140)
    expect(window.localStorage.getItem(ROSTER_RAIL_KEY)).toBeNull()
    expect(window.localStorage.getItem(ROSTER_WIDTH_KEY)).toBe("14")
  })

  it("steps onto the rail from its least width by the keys, and off it", () => {
    window.localStorage.setItem(ROSTER_WIDTH_KEY, String(ROSTER_WIDTH_MIN + 1))
    draw()
    fireEvent.keyDown(handle(), { key: "ArrowLeft" })
    expect(column().style.width).toBe(`${ROSTER_WIDTH_MIN}rem`)
    fireEvent.keyDown(handle(), { key: "ArrowLeft" })
    expect(column().style.width).toBe(`${ROSTER_RAIL_WIDTH}rem`)
    // No narrower than the rail.
    fireEvent.keyDown(handle(), { key: "ArrowLeft" })
    expect(column().style.width).toBe(`${ROSTER_RAIL_WIDTH}rem`)
    expect(window.localStorage.getItem(ROSTER_RAIL_KEY)).toBe("1")
    fireEvent.keyDown(handle(), { key: "ArrowRight" })
    expect(column().style.width).toBe(`${ROSTER_WIDTH_MIN}rem`)
    expect(window.localStorage.getItem(ROSTER_RAIL_KEY)).toBeNull()
    // Right to left, the right arrow is toward the narrower (jsdom does
    // not inherit `direction`: it is set on the handle itself).
    handle().style.direction = "rtl"
    fireEvent.keyDown(handle(), { key: "ArrowRight" })
    expect(column().style.width).toBe(`${ROSTER_RAIL_WIDTH}rem`)
  })

  it("ignores a width stored out of bounds", () => {
    window.localStorage.setItem(ROSTER_WIDTH_KEY, "3")
    draw()
    expect(column().style.width).toBe(`${ROSTER_WIDTH_MIN}rem`)
  })
})
