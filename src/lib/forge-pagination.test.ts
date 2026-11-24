/**
 * The pagination strip's arithmetic. Two properties matter beyond the obvious
 * shape: the strip never grows past a fixed width (so it does not reflow as
 * you walk a long list), and a gap marker is never used where it would hide
 * FEWER numbers than it occupies.
 */
import { describe, expect, it } from "vitest"

import { pageCount, pageSlots } from "./forge-pagination"

describe("pageSlots", () => {
  it("shows every page while they all fit", () => {
    expect(pageSlots(1, 1)).toEqual([1])
    expect(pageSlots(3, 5)).toEqual([1, 2, 3, 4, 5])
    // 7 is the widest run with no gap: first, last, current ± 1, and the two
    // single pages between them.
    expect(pageSlots(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it("keeps the first and last page reachable from the middle", () => {
    expect(pageSlots(10, 20)).toEqual([
      1,
      "ellipsis",
      9,
      10,
      11,
      "ellipsis",
      20,
    ])
  })

  it("never renders a gap that hides a single page", () => {
    // Page 3 of 9: the run 1,2,3,4 leaves only page 5..8 skipped on the right.
    expect(pageSlots(3, 9)).toEqual([1, 2, 3, 4, "ellipsis", 9])
    // One page missing → show it rather than a marker of the same width.
    expect(pageSlots(4, 8)).toEqual([1, 2, 3, 4, 5, "ellipsis", 8])
    expect(pageSlots(5, 8)).toEqual([1, "ellipsis", 4, 5, 6, 7, 8])
  })

  it("stays a fixed width however long the list is", () => {
    for (const total of [8, 50, 500, 10_000]) {
      for (const current of [1, 2, Math.floor(total / 2), total - 1, total]) {
        expect(pageSlots(current, total).length).toBeLessThanOrEqual(7)
      }
    }
  })

  it("clamps a current page that fell out of range", () => {
    // The page size can grow under a page number that no longer exists.
    expect(pageSlots(99, 3)).toEqual([1, 2, 3])
    expect(pageSlots(0, 3)).toEqual([1, 2, 3])
    expect(pageSlots(1, 0)).toEqual([])
  })

  /** A phone cannot fit seven numbers next to the page-size select. Dropping
   *  the neighbours is what shrinks; first, current and last stay, because
   *  without them the strip stops meaning anything. */
  it("narrows to a caller's slot budget", () => {
    expect(pageSlots(10, 20, 5)).toEqual([1, "ellipsis", 10, "ellipsis", 20])
    for (const total of [8, 50, 10_000]) {
      for (const current of [1, 2, Math.floor(total / 2), total]) {
        expect(pageSlots(current, total, 5).length).toBeLessThanOrEqual(5)
      }
    }
    // Still no gap for a single hidden page, and the ends stay whole.
    expect(pageSlots(3, 5, 5)).toEqual([1, 2, 3, 4, 5])
    expect(pageSlots(2, 20, 5)).toEqual([1, 2, "ellipsis", 20])

    // Below the floor there is nothing left to drop, so it behaves as 5 —
    // never as an empty or a first-and-last-only strip.
    expect(pageSlots(10, 20, 1)).toEqual(pageSlots(10, 20, 5))
    // A wider budget buys neighbours back, two slots at a time.
    expect(pageSlots(10, 20, 9)).toEqual([
      1,
      "ellipsis",
      8,
      9,
      10,
      11,
      12,
      "ellipsis",
      20,
    ])
  })
})

describe("pageCount", () => {
  it("rounds up, and keeps one page for an empty list", () => {
    expect(pageCount(0, 20)).toBe(1)
    expect(pageCount(1, 20)).toBe(1)
    expect(pageCount(57, 20)).toBe(3)
    expect(pageCount(60, 20)).toBe(3)
  })

  it("refuses to invent a count the forge did not give", () => {
    // GitLab omits its totals past 10k rows; a guess here would render page
    // numbers that lead nowhere.
    expect(pageCount(null, 20)).toBeNull()
    expect(pageCount(57, 0)).toBeNull()
  })
})
