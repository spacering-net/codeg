import { describe, expect, it } from "vitest"

import { createScrollSync, type ScrollPane } from "./use-synced-scroll"

/** A stand-in for a pane's scroll viewport. Writing an offset here is inert —
 *  it fires no event — so each test drives the echo explicitly, which is what
 *  makes the ordering readable. */
function pane(overrides: Partial<ScrollPane> = {}): ScrollPane {
  return {
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: 1000,
    clientHeight: 200,
    scrollWidth: 900,
    clientWidth: 300,
    ...overrides,
  }
}

describe("createScrollSync", () => {
  it("carries both axes from the scrolled pane to the other one", () => {
    const sync = createScrollSync()
    const left = pane()
    const right = pane()
    sync.register("left", left)
    sync.register("right", right)

    left.scrollTop = 120
    left.scrollLeft = 40
    sync.handleScroll("left")

    expect(right.scrollTop).toBe(120)
    expect(right.scrollLeft).toBe(40)
  })

  it("clamps the write to what the other pane can actually reach", () => {
    // The two sides of a diff rarely share a longest line.
    const sync = createScrollSync()
    const left = pane({ scrollWidth: 2000 })
    const right = pane({ scrollWidth: 400 })
    sync.register("left", left)
    sync.register("right", right)

    left.scrollLeft = 900
    sync.handleScroll("left")

    expect(right.scrollLeft).toBe(100)
  })

  it("does not drag the scrolled pane back when the other one clamped", () => {
    // The regression this whole module exists for: the clamped write echoes
    // back as a scroll event on the narrow pane, and propagating it would haul
    // the pane the user is holding back to the offset the narrow one could
    // reach — the long side becomes unscrollable past its neighbour's end.
    const sync = createScrollSync()
    const left = pane({ scrollWidth: 2000 })
    const right = pane({ scrollWidth: 400 })
    sync.register("left", left)
    sync.register("right", right)

    left.scrollLeft = 900
    sync.handleScroll("left")
    sync.handleScroll("right") // the echo of the write above

    expect(left.scrollLeft).toBe(900)
  })

  it("still follows the other pane once the echo is spent", () => {
    const sync = createScrollSync()
    const left = pane()
    const right = pane()
    sync.register("left", left)
    sync.register("right", right)

    left.scrollTop = 120
    sync.handleScroll("left")
    sync.handleScroll("right") // echo

    right.scrollTop = 300
    sync.handleScroll("right")

    expect(left.scrollTop).toBe(300)
  })

  it("records no echo when the other pane is already in position", () => {
    // Writing an offset a pane already holds fires no scroll event, so an echo
    // recorded for it would sit there and swallow the user's next scroll to
    // that exact offset.
    const sync = createScrollSync()
    const left = pane()
    const right = pane({ scrollTop: 120 })
    sync.register("left", left)
    sync.register("right", right)

    left.scrollTop = 120
    sync.handleScroll("left")

    // The user now scrolls the right pane back to where it started.
    right.scrollTop = 0
    sync.handleScroll("right")

    expect(left.scrollTop).toBe(0)
  })

  it("follows an RTL pane's negative offsets instead of pinning them at 0", () => {
    // An RTL scrollport reports `scrollLeft` as 0 at its right edge, counting
    // down into negatives. A `0..max` clamp would drop every horizontal move.
    // The diff panes pin themselves to `dir="ltr"`, but this helper must not
    // assume that of a caller.
    const sync = createScrollSync()
    const left = pane({ scrollWidth: 2000 })
    const right = pane({ scrollWidth: 400 })
    sync.register("left", left)
    sync.register("right", right)

    left.scrollLeft = -900
    sync.handleScroll("left")

    // Clamped to the far side's reach, with the sign kept.
    expect(right.scrollLeft).toBe(-100)
    sync.handleScroll("right") // echo
    expect(left.scrollLeft).toBe(-900)
  })

  it("ignores a scroll while the opposite pane is unmounted", () => {
    const sync = createScrollSync()
    const left = pane()
    sync.register("left", left)

    left.scrollTop = 60
    expect(() => sync.handleScroll("left")).not.toThrow()

    // Re-mounting the other side must not replay a stale echo.
    const right = pane()
    sync.register("right", right)
    left.scrollTop = 90
    sync.handleScroll("left")
    expect(right.scrollTop).toBe(90)
  })
})
