import { createRef } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { HarnessScroller } from "./harness-scroller"

describe("HarnessScroller", () => {
  it("puts the ref, the handlers and the attributes on the element that scrolls", () => {
    const ref = createRef<HTMLDivElement>()
    const onScroll = vi.fn()
    render(
      <HarnessScroller
        ref={ref}
        tabIndex={-1}
        role="log"
        aria-label="Output"
        onScroll={onScroll}
        className="flex-1"
      >
        <p>line</p>
      </HarnessScroller>
    )
    const viewport = screen.getByRole("log", { name: "Output" })
    expect(ref.current).toBe(viewport)
    expect(viewport).toHaveAttribute("tabindex", "-1")
    expect(viewport).toContainElement(screen.getByText("line"))
    // The box around it takes the layout classes, and is what a test (or a
    // style) finds the scroller by.
    const host = viewport.parentElement!
    expect(host).toHaveAttribute("data-harness-scroller")
    expect(host).toHaveClass("flex-1")

    fireEvent.scroll(viewport)
    expect(onScroll).toHaveBeenCalledTimes(1)
  })

  it("follows a callback ref, and lets go of it on unmount", () => {
    const seen: (HTMLDivElement | null)[] = []
    const { unmount } = render(
      <HarnessScroller ref={(element) => void seen.push(element)}>
        <p>line</p>
      </HarnessScroller>
    )
    expect(seen[0]).toBeInstanceOf(HTMLDivElement)
    unmount()
    expect(seen[seen.length - 1]).toBeNull()
  })
})
