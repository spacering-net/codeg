import { describe, expect, it } from "vitest"

import {
  clampAxis,
  clampOffset,
  clampZoom,
  containZoom,
  fitZoom,
  MAX_ZOOM,
  MIN_ZOOM,
  mermaidSourceFromPre,
  parseSvgSize,
  plantUmlSourceFromPre,
  stepZoom,
  stripSvgMaxWidth,
  zoomAroundPoint,
  ZOOM_FACTOR,
} from "./mermaid-view"

// A realistic Mermaid 11 root tag: `width="100%"`, the real size only in the
// viewBox, and an inline `max-width` that would cap every zoom above fit.
const MERMAID_SVG =
  '<svg aria-roledescription="flowchart-v2" viewBox="0 0 780 1240" ' +
  'style="max-width: 780px; background-color: transparent;" ' +
  'width="100%" id="mermaid-1" xmlns="http://www.w3.org/2000/svg">' +
  "<g></g></svg>"

describe("clampZoom / stepZoom", () => {
  it("holds the zoom inside the bounds", () => {
    expect(clampZoom(0)).toBe(MIN_ZOOM)
    expect(clampZoom(1000)).toBe(MAX_ZOOM)
    expect(clampZoom(1.5)).toBe(1.5)
  })

  it("falls back to 1 for a non-finite zoom", () => {
    expect(clampZoom(Number.NaN)).toBe(1)
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(1)
  })

  it("steps multiplicatively so every click feels the same", () => {
    expect(stepZoom(1, 1)).toBeCloseTo(ZOOM_FACTOR)
    expect(stepZoom(1, -1)).toBeCloseTo(1 / ZOOM_FACTOR)
    // Round-tripping returns to where it started — the button pair is stable.
    expect(stepZoom(stepZoom(2, 1), -1)).toBeCloseTo(2)
  })

  it("saturates at the bounds instead of overshooting", () => {
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM)
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM)
  })
})

describe("fitZoom", () => {
  it("shrinks a diagram wider than the column", () => {
    expect(fitZoom(1000, 500)).toBeCloseTo(0.5)
  })

  it("never blows a narrow diagram up to fill the column", () => {
    expect(fitZoom(200, 800)).toBe(1)
  })

  it("stays at 1 before the viewport has been measured", () => {
    expect(fitZoom(800, 0)).toBe(1)
    expect(fitZoom(0, 800)).toBe(1)
  })

  it("does not fit below the minimum zoom", () => {
    expect(fitZoom(100_000, 300)).toBe(MIN_ZOOM)
  })
})

describe("containZoom", () => {
  it("fits the limiting axis", () => {
    // Tall diagram in a wide box: height decides.
    expect(
      containZoom({ width: 500, height: 1000 }, { width: 1200, height: 800 })
    ).toBeCloseTo(0.8)
    // Wide diagram in a tall box: width decides.
    expect(
      containZoom({ width: 2000, height: 400 }, { width: 1000, height: 900 })
    ).toBeCloseTo(0.5)
  })

  it("never blows a small diagram up past its natural size", () => {
    expect(
      containZoom({ width: 200, height: 100 }, { width: 1200, height: 800 })
    ).toBe(1)
  })

  it("stays at 1 while any dimension is unmeasured", () => {
    expect(
      containZoom({ width: 500, height: 500 }, { width: 0, height: 800 })
    ).toBe(1)
    expect(
      containZoom({ width: 0, height: 500 }, { width: 800, height: 800 })
    ).toBe(1)
  })
})

describe("zoomAroundPoint", () => {
  it("keeps the content point under the cursor fixed", () => {
    const zoom = 1
    const nextZoom = 2
    const offset = { x: -40, y: -10 }
    const point = { x: 300, y: 120 }

    const next = zoomAroundPoint({ zoom, nextZoom, offset, point })

    // The content coordinate under the cursor is unchanged by the zoom.
    const before = {
      x: (point.x - offset.x) / zoom,
      y: (point.y - offset.y) / zoom,
    }
    const after = {
      x: (point.x - next.x) / nextZoom,
      y: (point.y - next.y) / nextZoom,
    }
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
  })

  it("is a no-op when the zoom does not change", () => {
    const offset = { x: 12, y: -34 }
    expect(
      zoomAroundPoint({ zoom: 2, nextZoom: 2, offset, point: { x: 5, y: 5 } })
    ).toEqual(offset)
  })

  it("returns the offset untouched for a degenerate zoom", () => {
    const offset = { x: 1, y: 2 }
    expect(
      zoomAroundPoint({ zoom: 0, nextZoom: 2, offset, point: { x: 0, y: 0 } })
    ).toBe(offset)
  })
})

describe("clampAxis / clampOffset", () => {
  it("centres content that fits, ignoring any remembered pan", () => {
    expect(clampAxis(-500, 200, 800)).toBe(300)
    expect(clampAxis(0, 800, 800)).toBe(0)
  })

  it("pins overflowing content so neither edge comes inside the viewport", () => {
    // Dragging right past the left edge.
    expect(clampAxis(120, 1600, 800)).toBe(0)
    // Dragging left past the right edge.
    expect(clampAxis(-5000, 1600, 800)).toBe(-800)
    // In range: left alone.
    expect(clampAxis(-300, 1600, 800)).toBe(-300)
  })

  it("clamps both axes independently", () => {
    expect(
      clampOffset(
        { x: -9999, y: 40 },
        { width: 1600, height: 200 },
        { width: 800, height: 400 }
      )
    ).toEqual({ x: -800, y: 100 })
  })
})

describe("parseSvgSize", () => {
  it("reads the natural size from the viewBox", () => {
    expect(parseSvgSize(MERMAID_SVG)).toEqual({ width: 780, height: 1240 })
  })

  it("accepts a comma-separated viewBox", () => {
    expect(parseSvgSize('<svg viewBox="0,0,10,20"></svg>')).toEqual({
      width: 10,
      height: 20,
    })
  })

  it("falls back to pixel width/height attributes", () => {
    expect(parseSvgSize('<svg width="300" height="150"></svg>')).toEqual({
      width: 300,
      height: 150,
    })
  })

  it("ignores a percentage width with no usable viewBox", () => {
    expect(parseSvgSize('<svg width="100%" height="100%"></svg>')).toBeNull()
  })

  it("rejects a degenerate viewBox and markup with no svg tag", () => {
    expect(parseSvgSize('<svg viewBox="0 0 0 0"></svg>')).toBeNull()
    expect(parseSvgSize("<div>not a diagram</div>")).toBeNull()
  })
})

describe("stripSvgMaxWidth", () => {
  it("removes only the max-width declaration from the root tag", () => {
    const stripped = stripSvgMaxWidth(MERMAID_SVG)
    expect(stripped).not.toMatch(/max-width/i)
    // Everything else on the tag survives.
    expect(stripped).toContain("background-color: transparent")
    expect(stripped).toContain('viewBox="0 0 780 1240"')
    expect(stripped).toContain('width="100%"')
  })

  it("leaves nested styles alone", () => {
    const svg =
      '<svg viewBox="0 0 10 10" style="max-width: 10px;">' +
      "<style>.node{max-width:5px}</style></svg>"
    expect(stripSvgMaxWidth(svg)).toContain(".node{max-width:5px}")
  })

  it("is a no-op when there is nothing to strip", () => {
    const svg = '<svg viewBox="0 0 10 10"></svg>'
    expect(stripSvgMaxWidth(svg)).toBe(svg)
  })
})

describe("mermaidSourceFromPre", () => {
  const pre = (className: unknown, children: unknown) => ({
    props: { className, children },
  })

  it("claims a language-mermaid fence and returns its source", () => {
    expect(
      mermaidSourceFromPre(pre("language-mermaid", "graph TD;\nA-->B;"))
    ).toBe("graph TD;\nA-->B;")
  })

  it("matches when other classes sit alongside it", () => {
    expect(
      mermaidSourceFromPre(pre("hljs language-mermaid extra", "graph TD;"))
    ).toBe("graph TD;")
  })

  it("does not claim a look-alike language", () => {
    expect(mermaidSourceFromPre(pre("language-mermaidx", "x"))).toBeNull()
    expect(mermaidSourceFromPre(pre("language-mermaid-lite", "x"))).toBeNull()
    expect(mermaidSourceFromPre(pre("language-ts", "x"))).toBeNull()
  })

  it("declines anything that is not an element with string content", () => {
    expect(mermaidSourceFromPre(null)).toBeNull()
    expect(mermaidSourceFromPre("just text")).toBeNull()
    expect(mermaidSourceFromPre(pre(undefined, "x"))).toBeNull()
    expect(
      mermaidSourceFromPre(pre("language-mermaid", { nested: 1 }))
    ).toBeNull()
  })
})

describe("plantUmlSourceFromPre", () => {
  const pre = (className: unknown, children: unknown) => ({
    props: { className, children },
  })
  const SOURCE = "@startuml\nAlice -> Bob: hi\n@enduml"

  it("claims a language-plantuml or language-puml fence", () => {
    expect(plantUmlSourceFromPre(pre("language-plantuml", SOURCE))).toBe(SOURCE)
    expect(plantUmlSourceFromPre(pre("language-puml", SOURCE))).toBe(SOURCE)
    expect(
      plantUmlSourceFromPre(pre("hljs language-plantuml extra", SOURCE))
    ).toBe(SOURCE)
  })

  it("does not claim a look-alike language, or a Mermaid fence", () => {
    expect(plantUmlSourceFromPre(pre("language-plantumlx", "x"))).toBeNull()
    expect(plantUmlSourceFromPre(pre("language-puml-lite", "x"))).toBeNull()
    expect(plantUmlSourceFromPre(pre("language-uml", "x"))).toBeNull()
    expect(plantUmlSourceFromPre(pre("language-mermaid", "x"))).toBeNull()
    expect(mermaidSourceFromPre(pre("language-plantuml", "x"))).toBeNull()
  })

  it("declines anything that is not an element with string content", () => {
    expect(plantUmlSourceFromPre(null)).toBeNull()
    expect(
      plantUmlSourceFromPre(pre("language-plantuml", { nested: 1 }))
    ).toBeNull()
  })
})
