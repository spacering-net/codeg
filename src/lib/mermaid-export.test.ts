import { describe, expect, it, vi } from "vitest"

import { saveDiagram, sizeSvgForRaster } from "./mermaid-export"

const mocks = vi.hoisted(() => ({
  saveTextFile: vi.fn(async () => "saved" as const),
}))

vi.mock("@/lib/save-file", () => ({ saveTextFile: mocks.saveTextFile }))

// Mermaid 11's root tag: `width="100%"`, the real size only in the viewBox,
// plus an inline `max-width` that would cap the raster back down to 1x.
const MERMAID_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" aria-roledescription="flowchart-v2" ' +
  'viewBox="0 0 400 250" style="max-width: 400px; background-color: transparent;" ' +
  'width="100%" id="mermaid-1"><g><rect width="10" height="10"/></g></svg>'

describe("sizeSvgForRaster", () => {
  it("takes the pixel size from the viewBox and scales it", () => {
    const sized = sizeSvgForRaster(MERMAID_SVG, 3)
    expect(sized).not.toBeNull()
    expect(sized).toMatchObject({ width: 1200, height: 750 })
    expect(sized?.svg).toContain('width="1200"')
    expect(sized?.svg).toContain('height="750"')
  })

  it("drops the inline max-width that would cap the raster at 1x", () => {
    const sized = sizeSvgForRaster(MERMAID_SVG, 3)
    expect(sized?.svg).not.toMatch(/max-width/i)
    // Unrelated declarations on the same attribute survive.
    expect(sized?.svg).toContain("background-color: transparent")
  })

  it("keeps the diagram body intact", () => {
    const sized = sizeSvgForRaster(MERMAID_SVG, 2)
    expect(sized?.svg).toContain('<rect width="10" height="10"')
    expect(sized?.svg).toContain('viewBox="0 0 400 250"')
  })

  it('never reads Mermaid\'s `width="100%"` as 100 pixels', () => {
    // No viewBox to fall back on: a naive parseFloat would report a 100x100
    // diagram here and silently export a tiny crop.
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"></svg>'
    expect(sizeSvgForRaster(svg, 3)).toBeNull()
  })

  it("falls back to absolute width/height attributes", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="300px" height="150"></svg>'
    expect(sizeSvgForRaster(svg, 2)).toMatchObject({ width: 600, height: 300 })
  })

  it("returns null for a degenerate viewBox with no usable fallback", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 0 0"></svg>'
    expect(sizeSvgForRaster(svg, 3)).toBeNull()
  })

  it("returns null for markup that is not an svg document", () => {
    expect(sizeSvgForRaster("<div>not a diagram</div>", 3)).toBeNull()
    expect(sizeSvgForRaster("", 3)).toBeNull()
  })

  it("rounds the raster size to whole pixels", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100.4 33.3"></svg>'
    expect(sizeSvgForRaster(svg, 1.5)).toMatchObject({ width: 151, height: 50 })
  })
})

describe("saveDiagram", () => {
  it("saves a Mermaid fence's source as .mmd", async () => {
    await saveDiagram({ format: "mmd", svg: null, source: "graph TD;" })

    expect(mocks.saveTextFile).toHaveBeenLastCalledWith({
      content: "graph TD;",
      suggestedName: "diagram.mmd",
      mimeType: "text/plain",
      filterName: "Mermaid",
      ext: "mmd",
    })
  })

  it("saves a PlantUML fence's source as .puml, without needing the drawing", async () => {
    const source = "@startuml\nAlice -> Bob\n@enduml"

    await expect(
      saveDiagram({ format: "puml", svg: null, source })
    ).resolves.toBe("saved")

    expect(mocks.saveTextFile).toHaveBeenLastCalledWith({
      content: source,
      suggestedName: "diagram.puml",
      mimeType: "text/plain",
      filterName: "PlantUML",
      ext: "puml",
    })
  })
})
