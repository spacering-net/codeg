import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { ChromeReserve } from "./chrome-reserve"

function reserveIn(container: HTMLElement): HTMLElement {
  const el = container.querySelector(".chrome-reserve")
  if (!(el instanceof HTMLElement)) throw new Error("no reserve rendered")
  return el
}

describe("ChromeReserve", () => {
  it("renders a window-drag slot of the given width over the strip hairline", () => {
    const { container } = render(<ChromeReserve width={116} />)
    const el = reserveIn(container)
    expect(el.style.width).toBe("116px")
    expect(el).toHaveAttribute("data-tauri-drag-region")
    expect(el).toHaveAttribute("aria-hidden", "true")
    expect(el).toHaveClass("shrink-0", "ws-strip-line")
  })

  // The workbench-route band draws its own bottom border (only when a title
  // renders); a hairline on the reserve would stack a second line above it.
  it("leaves the hairline out for a band that draws its own border", () => {
    const { container } = render(<ChromeReserve width={80} line={false} />)
    expect(reserveIn(container)).not.toHaveClass("ws-strip-line")
  })

  // The width transition in globals.css only runs on a node that survives the
  // toggle — a reserve that mounted or unmounted on it snapped instead.
  it("keeps one node while its width moves to and from zero", () => {
    const { container, rerender } = render(<ChromeReserve width={0} />)
    const node = reserveIn(container)
    expect(node.style.width).toBe("0px")
    rerender(<ChromeReserve width={254} />)
    expect(reserveIn(container)).toBe(node)
    expect(node.style.width).toBe("254px")
    rerender(<ChromeReserve width={0} />)
    expect(reserveIn(container)).toBe(node)
    expect(node.style.width).toBe("0px")
  })
})
