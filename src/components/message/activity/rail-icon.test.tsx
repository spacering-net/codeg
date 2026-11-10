import { render } from "@testing-library/react"
import { FilePenLineIcon, SquareTerminalIcon } from "lucide-react"
import { describe, expect, it } from "vitest"

import { RailIcon } from "./rail-icon"

function glyphOf(view: ReturnType<typeof render>): SVGSVGElement {
  return view.container.querySelector("svg")!
}

describe("RailIcon", () => {
  // The glyph covers the ring and its viewBox draws it in the middle: drawn
  // in a smaller box of its own, the glyph and the ring snapped to the device
  // pixels apart, and sat half a pixel off each other at 90% or 110% zoom.
  it("draws its glyph over the whole ring, scaled to the middle", () => {
    const md = glyphOf(
      render(<RailIcon icon={SquareTerminalIcon} status="succeeded" />)
    )
    expect(md).toHaveClass("absolute", "inset-0", "size-full")
    // 24 units across 12px of a 20px ring.
    expect(md.getAttribute("viewBox")).toBe("-8 -8 40 40")
    const sm = glyphOf(
      render(
        <RailIcon icon={SquareTerminalIcon} status="succeeded" size="sm" />
      )
    )
    // 10px of a 16px one.
    expect(sm.getAttribute("viewBox")).toBe("-7.2 -7.2 38.4 38.4")
  })

  it("centres a drawing that sits off the middle of its box", () => {
    // file-pen-line's pen reaches a unit further right than its page does left.
    const glyph = glyphOf(
      render(<RailIcon icon={FilePenLineIcon} status="succeeded" />)
    )
    expect(glyph.getAttribute("viewBox")).toBe("-7 -8 40 40")
  })

  // A grey glyph inks in with its row on hover (globals.css); a tone stays.
  it("marks a grey glyph, and only a grey one, as quiet", () => {
    const quiet = ["succeeded", "pending", "running", "cancelled"] as const
    for (const status of quiet) {
      const glyph = glyphOf(
        render(<RailIcon icon={SquareTerminalIcon} status={status} />)
      )
      expect(glyph).toHaveAttribute("data-quiet")
    }
    for (const status of ["awaiting", "failed", "rejected"] as const) {
      const glyph = glyphOf(
        render(<RailIcon icon={SquareTerminalIcon} status={status} />)
      )
      expect(glyph).not.toHaveAttribute("data-quiet")
    }
  })
})
