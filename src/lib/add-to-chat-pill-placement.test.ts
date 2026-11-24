import { describe, expect, it } from "vitest"
import { getAddToChatPillPlacement } from "./add-to-chat-pill-placement"

// Measured in Chrome against monaco-editor 0.55.1 with the shipped defaults
// (editor font 13 => 20px lines on macOS / 18px on Windows, pill box 25px).
const PILL = 25
const LINE = 20

/** A normally-sized editor: only `spaceAbovePx` is ever the deciding factor. */
function at(spaceAbovePx: number | null, spaceBelowPx = 400) {
  return getAddToChatPillPlacement({
    spaceAbovePx,
    spaceBelowPx,
    lineHeightPx: LINE,
    pillHeightPx: PILL,
  })
}

describe("getAddToChatPillPlacement", () => {
  it("keeps a first-line selection below the editor chrome", () => {
    // Anchor flush with the viewport top: zero room above.
    expect(at(0)).toEqual(["below", "above"])
  })

  it("keeps a second-line selection below the editor chrome", () => {
    // One line of room (20px) is still less than the pill (25px), so ABOVE
    // would clip the pill's top edge into the file path bar.
    expect(at(LINE)).toEqual(["below", "above"])
  })

  it("keeps the existing above-first placement once the pill clears the top", () => {
    expect(at(2 * LINE)).toEqual(["above", "below"])
  })

  it("treats an exactly-fitting gap as room enough for above", () => {
    expect(at(PILL)).toEqual(["above", "below"])
  })

  it("keeps the existing above-first placement deep in the viewport", () => {
    expect(at(180)).toEqual(["above", "below"])
  })

  it("goes below for a top line that is only partially scrolled into view", () => {
    // A 1.5-line scroll leaves 10px above the anchor — Monaco's page-relative
    // check still says ABOVE fits, but it does not.
    expect(at(10)).toEqual(["below", "above"])
  })

  it("goes below for an anchor still half in view at the top", () => {
    expect(at(-LINE / 2)).toEqual(["below", "above"])
  })

  it("falls back to the existing order when the anchor top is unknown", () => {
    expect(at(null)).toEqual(["above", "below"])
  })

  it("scales with the pill: a taller (zoomed) pill needs more room", () => {
    const zoomed = (spaceAbovePx: number) =>
      getAddToChatPillPlacement({
        spaceAbovePx,
        spaceBelowPx: 400,
        lineHeightPx: 40,
        pillHeightPx: 50,
      })
    expect(zoomed(40)).toEqual(["below", "above"])
    expect(zoomed(60)).toEqual(["above", "below"])
  })

  describe("when the anchor line has scrolled out of the viewport", () => {
    it("withholds the pill for an anchor wholly above the viewport", () => {
      expect(at(-LINE)).toEqual([])
      expect(at(-200)).toEqual([])
    })

    it("withholds the pill for an anchor wholly below the viewport", () => {
      // Editor dragged short while a selection further down stayed anchored:
      // Monaco still renders a little past the viewport, and from out there
      // both placements land outside the editor.
      expect(at(300, -LINE)).toEqual([])
      expect(at(300, -200)).toEqual([])
    })

    it("still places for an anchor only partially cut at the bottom", () => {
      expect(at(300, -LINE / 2)).toEqual(["above", "below"])
    })
  })

  describe("when the editor is too short to seat the pill on either side", () => {
    it("takes the roomier side", () => {
      // ~2-line editor (terminal splitter pulled all the way up). Monaco's
      // EXACT would be the only never-overflowing answer, but it is unusable
      // for an overflowing widget, so lose the fewest pixels instead.
      expect(at(0, LINE)).toEqual(["below", "above"])
      expect(at(LINE, 0)).toEqual(["above", "below"])
    })

    it("prefers a fitting below over the roomier-side tie-break", () => {
      expect(at(0, PILL)).toEqual(["below", "above"])
    })

    it("never demotes a fitting above just because the bottom is cramped", () => {
      expect(at(300, 0)).toEqual(["above", "below"])
    })
  })
})
