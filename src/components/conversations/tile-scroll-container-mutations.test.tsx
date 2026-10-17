import { render } from "@testing-library/react"
import { OverlayScrollbars } from "overlayscrollbars"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { TileScrollContainer } from "./tile-scroll-container"

// The real OverlayScrollbars, no module mock (unlike the sibling test file):
// what is under test is the library's own content MutationObserver, which
// measures the viewport — a `scrollWidth` read, i.e. a synchronous layout —
// in the observer callback for every mutation it does not ignore.

const nativeScrollWidth = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "scrollWidth"
)!
let scrollWidthReads = 0

beforeEach(() => {
  scrollWidthReads = 0
  Object.defineProperty(Element.prototype, "scrollWidth", {
    configurable: true,
    get() {
      scrollWidthReads++
      return nativeScrollWidth.get!.call(this)
    },
  })
})

afterEach(() => {
  Object.defineProperty(Element.prototype, "scrollWidth", nativeScrollWidth)
})

// Mutation records are delivered in a microtask; one macrotask turn is enough
// for every pending delivery to have run.
const flushMutations = () => new Promise((resolve) => setTimeout(resolve, 0))

function renderTiledRow() {
  return render(
    <TileScrollContainer canTile>
      <div data-testid="row">
        <div data-tile-scroll-item="" data-testid="tile">
          <p data-testid="transcript">first token</p>
        </div>
        <div data-tile-scroll-item="">
          <p>another conversation</p>
        </div>
      </div>
    </TileScrollContainer>
  )
}

describe("TileScrollContainer content observation", () => {
  it("runs a real OverlayScrollbars instance while tiled", () => {
    const { container } = renderTiledRow()
    const host = container.firstElementChild as HTMLElement
    expect(OverlayScrollbars(host)).toBeTruthy()
  })

  it("does not re-measure the row for what a tile renders", async () => {
    const { getByTestId } = renderTiledRow()
    await flushMutations()
    scrollWidthReads = 0

    const transcript = getByTestId("transcript")
    // A streamed token, a new block, and a JS-driven animation frame (the
    // shimmer writes its inline style every frame).
    transcript.firstChild!.textContent = "first token, second token"
    transcript.append(document.createElement("pre"))
    transcript.setAttribute("style", "background-position: 40% center")
    await flushMutations()

    expect(scrollWidthReads).toBe(0)
  })

  it("does not re-measure for tile content detached before delivery", async () => {
    const { getByTestId } = renderTiledRow()
    const transcript = getByTestId("transcript")
    const token = document.createElement("span")
    token.textContent = "token"
    transcript.append(token)
    await flushMutations()
    scrollWidthReads = 0

    // Edited and then dropped in the same commit: by delivery the text node is
    // no longer in the document, so its record can't be placed in a tile.
    token.firstChild!.textContent = "token, edited"
    token.remove()
    await flushMutations()

    expect(scrollWidthReads).toBe(0)
  })

  it("still re-measures when the set of tiles changes", async () => {
    const { getByTestId } = renderTiledRow()
    await flushMutations()
    scrollWidthReads = 0

    const tile = document.createElement("div")
    tile.setAttribute("data-tile-scroll-item", "")
    getByTestId("row").append(tile)
    await flushMutations()

    expect(scrollWidthReads).toBeGreaterThan(0)
  })

  it("still re-measures when a tile's own box changes", async () => {
    const { getByTestId } = renderTiledRow()
    await flushMutations()
    scrollWidthReads = 0

    getByTestId("tile").setAttribute("class", "min-w-[32rem]")
    await flushMutations()

    expect(scrollWidthReads).toBeGreaterThan(0)
  })
})
