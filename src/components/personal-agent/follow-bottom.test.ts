import { describe, expect, it } from "vitest"

import {
  afterScroll,
  farFromBottom,
  followsBottom,
  NEAR_BOTTOM_PX,
  STICK_PX,
} from "./follow-bottom"

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

describe("farFromBottom", () => {
  it("shows the way down past the conversation's slack, as it shows there", () => {
    expect(farFromBottom({ following: false, gap: NEAR_BOTTOM_PX + 1 })).toBe(
      true
    )
    expect(farFromBottom({ following: false, gap: NEAR_BOTTOM_PX })).toBe(false)
    // A glance up a little way, not half a view: it shows.
    expect(farFromBottom({ following: false, gap: 120 })).toBe(true)
  })

  it("does not while the list follows, however far its content grew", () => {
    expect(farFromBottom({ following: true, gap: 5000 })).toBe(false)
  })
})

describe("afterScroll", () => {
  const base = { gap: 300, top: 600, lastTop: 900, gliding: false }

  it("follows near the bottom, whoever scrolled", () => {
    expect(afterScroll({ ...base, was: false, gap: 0, user: false })).toEqual({
      following: true,
      restick: false,
    })
  })

  it("lets the reader's own scroll up leave the bottom", () => {
    expect(afterScroll({ ...base, was: true, user: true })).toEqual({
      following: false,
      restick: false,
    })
  })

  it("puts a following list back when its own move took it off the bottom", () => {
    // virtua keeping what is drawn in place as it measures the rows: no
    // input of the reader's before it.
    expect(afterScroll({ ...base, was: true, user: false })).toEqual({
      following: true,
      restick: true,
    })
  })

  it("leaves a reader up the page where they are on the list's own moves", () => {
    expect(afterScroll({ ...base, was: false, user: false })).toEqual({
      following: false,
      restick: false,
    })
  })

  it("lets a glide to the bottom get there itself", () => {
    expect(
      afterScroll({ ...base, was: true, user: false, gliding: true })
    ).toEqual({ following: true, restick: false })
  })
})
