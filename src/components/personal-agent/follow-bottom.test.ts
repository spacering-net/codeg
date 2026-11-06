import { describe, expect, it } from "vitest"

import { followsBottom, STICK_PX } from "./follow-bottom"

describe("followsBottom", () => {
  it("follows near the bottom, whatever it did before", () => {
    expect(followsBottom({ was: false, gap: 0, top: 900, lastTop: 400 })).toBe(
      true
    )
    expect(
      followsBottom({ was: false, gap: STICK_PX - 1, top: 10, lastTop: 50 })
    ).toBe(true)
  })

  it("stops when the reader scrolls up away from the bottom", () => {
    expect(
      followsBottom({ was: true, gap: STICK_PX, top: 880, lastTop: 940 })
    ).toBe(false)
  })

  /**
   * A message landed (the content grew by 92px) and the browser's scroll
   * anchoring nudged the view down 6px in the same frame: the scroll event
   * sees an 86px gap, but the view did not move up — still following, so the
   * size change that comes next takes it to the new bottom.
   */
  it("keeps following when the content grows below with an anchoring nudge", () => {
    expect(
      followsBottom({ was: true, gap: 86, top: 4588, lastTop: 4582 })
    ).toBe(true)
    expect(
      followsBottom({ was: true, gap: 92, top: 4582, lastTop: 4582 })
    ).toBe(true)
  })

  it("does not start following on a move down that stops short of the bottom", () => {
    expect(
      followsBottom({ was: false, gap: 300, top: 1200, lastTop: 900 })
    ).toBe(false)
  })
})
