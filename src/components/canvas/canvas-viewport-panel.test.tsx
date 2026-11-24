import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fireEvent, render, screen } from "@testing-library/react"
import { ReactFlowProvider } from "@xyflow/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import { CanvasViewportPanel } from "./canvas-dock"

/**
 * The corner stack: the navigator map, and under it the controls that zoom the
 * board and show or hide the map itself.
 *
 * The map used to own the opposite corner, which is why the toggle can't just
 * be a piece of local state — a control that forgets on every route switch is
 * worse than no control, because the map is back in the way each time and the
 * user has to dismiss it again. The default is the other half: shown, because
 * that is how a board bigger than the window stays navigable.
 */

const MINIMAP_KEY = "workspace:canvas-minimap"

/** jsdom lays nothing out, so the panel would measure the controls at 0 and
 *  fall back to ReactFlow's default map size. This is the pill reporting a
 *  width the way a browser would. */
const PILL_WIDTH = 240

function stubPillWidth(width: number): () => void {
  const original = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const w = this.getAttribute("role") === "toolbar" ? width : 0
    return { ...new DOMRect(0, 0, w, 0).toJSON(), width: w } as DOMRect
  }
  return () => {
    HTMLElement.prototype.getBoundingClientRect = original
  }
}

function renderPanel() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ReactFlowProvider>
        <CanvasViewportPanel />
      </ReactFlowProvider>
    </NextIntlClientProvider>
  )
}

/** ReactFlow tags the map's own wrapper with this. */
function map(): HTMLElement | null {
  return document.querySelector(".react-flow__minimap")
}

describe("the canvas viewport panel", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("shows the map when nothing has been remembered", () => {
    renderPanel()
    expect(map()).not.toBeNull()
  })

  it("hides the map on the toggle and remembers it", () => {
    const { unmount } = renderPanel()
    fireEvent.click(screen.getByRole("button", { name: "Hide map" }))
    expect(map()).toBeNull()
    expect(localStorage.getItem(MINIMAP_KEY)).toBe("false")

    // The reason this is on disk at all: the canvas route unmounts every time
    // the user goes back to the workspace.
    unmount()
    renderPanel()
    expect(map()).toBeNull()
    expect(screen.getByRole("button", { name: "Show map" })).toBeTruthy()
  })

  it("brings the map back and remembers that too", () => {
    localStorage.setItem(MINIMAP_KEY, "false")
    const { unmount } = renderPanel()
    fireEvent.click(screen.getByRole("button", { name: "Show map" }))
    expect(map()).not.toBeNull()
    unmount()
    renderPanel()
    expect(map()).not.toBeNull()
  })

  it("states which way it is pointing, not just what it will do", () => {
    // The label alone ("Hide map") only reaches someone who can also see
    // whether the map is there.
    renderPanel()
    expect(
      screen
        .getByRole("button", { name: "Hide map" })
        .getAttribute("aria-pressed")
    ).toBe("true")
    fireEvent.click(screen.getByRole("button", { name: "Hide map" }))
    expect(
      screen
        .getByRole("button", { name: "Show map" })
        .getAttribute("aria-pressed")
    ).toBe("false")
  })

  it("takes the map out of its own panel's absolute positioning", () => {
    // MiniMap renders a ReactFlow `<Panel>`, which the vendor stylesheet makes
    // `position: absolute; margin: 15px`. Inside THIS panel that drops it onto
    // the buttons instead of above them. It is an inline style rather than a
    // rule in globals.css on purpose: an override there wins on specificity but
    // only if the browser received it, and a stale dev CSS chunk of that exact
    // rule is how this shipped broken once.
    renderPanel()
    const el = map() as HTMLElement
    expect(el.style.position).toBe("static")
    expect(el.style.margin).toBe("0px")
  })

  it("draws the map as wide as the controls under it", () => {
    // Measured rather than set to a constant: the controls are drawn in rem and
    // the appearance zoom is a root font-size, so any px number would line up at
    // 100% and drift at every other step.
    const restore = stubPillWidth(PILL_WIDTH)
    try {
      renderPanel()
      const el = map() as HTMLElement
      expect(el.style.width).toBe(`${PILL_WIDTH}px`)
      // ReactFlow's own 200×150 proportions, so a wider map doesn't flatten
      // into a strip.
      expect(el.style.height).toBe("180px")
      // The svg is sized from the same two numbers — and DIVIDED by them to
      // build the viewBox, which is why a percentage can't be used here.
      const svg = el.querySelector("svg") as SVGElement
      expect(svg.getAttribute("width")).toBe(String(PILL_WIDTH))
      expect(svg.getAttribute("height")).toBe("180")
      expect(svg.getAttribute("viewBox")).not.toContain("NaN")
    } finally {
      restore()
    }
  })

  it("gives the map the same lift as the controls", () => {
    // Two boards' worth of chrome floating over the same surface; one of them
    // casting no shadow read as a hole punched in the board.
    renderPanel()
    expect((map() as HTMLElement).className).toContain("shadow-lg")
  })

  it("fills the map button while the map is up", () => {
    // `aria-pressed` is the half of this that only reaches a screen reader.
    renderPanel()
    const button = screen.getByRole("button", { name: "Hide map" })
    expect(button.className).toContain("bg-primary")
    fireEvent.click(button)
    expect(
      screen.getByRole("button", { name: "Show map" }).className
    ).not.toContain("bg-primary")
  })

  it("keeps the map and the controls in one panel", () => {
    // Two ReactFlow panels in one corner are two absolutely-positioned boxes
    // that have to be kept apart by hand-computed offsets — the arrangement
    // that already let the dock run under this pill once. One flex column with
    // a gap cannot drift.
    renderPanel()
    const panels = document.querySelectorAll(".react-flow__panel")
    const outer = document.querySelector(
      ".react-flow__panel:not(.react-flow__minimap)"
    )
    expect(outer).not.toBeNull()
    expect(outer!.contains(map())).toBe(true)
    // The map's own wrapper is the only other one, and it is inside this one.
    expect(panels.length).toBe(2)
  })

  it("stays out of an exported PNG", () => {
    // `exportPng` filters on this attribute. It sits on the outer panel, which
    // is now what carries the map as well.
    renderPanel()
    const outer = document.querySelector(
      ".react-flow__panel:not(.react-flow__minimap)"
    ) as HTMLElement
    expect(outer.dataset.canvasExportSkip).toBe("")
  })

  it("is what the canvas renders, with no second map beside it", () => {
    // The map moved out of `canvas-view` and into this panel. Leaving the old
    // one behind would put two maps on the board, one of them unremovable.
    const view = readFileSync(
      resolve(process.cwd(), "src/components/canvas/canvas-view.tsx"),
      "utf8"
    )
    expect(view).toContain("<CanvasViewportPanel />")
    expect(view).not.toContain("<MiniMap")
  })
})
