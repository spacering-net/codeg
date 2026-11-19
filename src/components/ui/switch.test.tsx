import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { Switch } from "./switch"

afterEach(cleanup)

function thumbOf(el: HTMLElement): HTMLElement {
  return el.querySelector("[data-slot=switch-thumb]") as HTMLElement
}

describe("Switch", () => {
  it("keeps its size by default", () => {
    render(<Switch aria-label="On" />)
    const root = screen.getByRole("switch", { name: "On" })
    expect(root.getAttribute("data-size")).toBe("default")
    expect(root.className).toContain("h-5 w-9")
    expect(thumbOf(root).className).toContain("size-4")
    expect(thumbOf(root).className).toContain(
      "data-[state=checked]:translate-x-4"
    )
  })

  it("small: a size down, its thumb travelling as far as there is room", () => {
    render(<Switch size="sm" aria-label="On" defaultChecked />)
    const root = screen.getByRole("switch", { name: "On" })
    expect(root.getAttribute("data-size")).toBe("sm")
    expect(root.className).toContain("h-4 w-7")
    expect(root.className).not.toContain("h-5")
    const thumb = thumbOf(root)
    expect(thumb.className).toContain("size-3")
    // 28px wide less its 1px edges, a 12px thumb 2px in from the start:
    // 12px of travel, mirrored right to left.
    expect(thumb.className).toContain("data-[state=checked]:translate-x-3")
    expect(thumb.className).toContain("rtl:data-[state=checked]:-translate-x-3")
    expect(thumb.className).not.toContain("translate-x-4")
  })
})
